/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   server.js                                          :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: pfalli <pfalli@student.42wolfsburg.de>     +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2025/05/06 14:35:06 by beredzhe          #+#    #+#             */
/*   Updated: 2025/07/09 11:54:00 by pfalli           ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

import dotenv from 'dotenv';

import fs from 'fs'
import { existsSync, readFileSync } from 'fs';
import path, { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import fastifyFormbody from '@fastify/formbody';
import fastifyCors from '@fastify/cors';
import { Server } from 'socket.io';
import GameEngine from './GameLogic/GameEngine.js';
import Tournament from './GameLogic/Tournament.js';
import LocalTournamentMode from './GameLogic/LocalTournamentMode.js';
import GameManager from './GameLogic/GameManager.js';
import DB from './data_controller/dbConfig.js';
import {developerRoutes, credentialsRoutes} from './routes/routes.js'; // Import the routes
import { getJWTSecret } from './routes/routes.js';
import jwt from 'jsonwebtoken';

let countdownInterval = null;

// Fix __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from parent directory
dotenv.config({ path: path.join(__dirname, '../.env') });

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
	fs.mkdirSync(uploadsDir, { recursive: true });
}
const avatarsDir = path.join(uploadsDir, 'avatars');
if (!fs.existsSync(avatarsDir)) {
	fs.mkdirSync(avatarsDir, { recursive: true });
}

// Create uploads directory if it doesn't exist
if (!fs.existsSync(avatarsDir)) {
	fs.mkdirSync(avatarsDir, { recursive: true });
}

const PORT = process.env.PORT || 8443;
const HOST = '0.0.0.0'; // Bind to all network interfaces

// Load SSL certificates
const keyPath = join(__dirname, 'https_keys/private-key.pem');
const certPath = join(__dirname, 'https_keys/certificate.pem');

if (!existsSync(keyPath) || !existsSync(certPath)) {
	console.error(`Error: SSL certificate files not found at ${keyPath} or ${certPath}.`);
	console.error('Please ensure the certificates exist or adjust the paths in server.js.');
	process.exit(1);
}

const httpsOptions = {
	key: readFileSync(keyPath),
	cert: readFileSync(certPath),
};

const app = fastify({
	logger: false,
	https: httpsOptions,
});

const server = app.server; // Get the underlying HTTPS server
const io = new Server(server, {
	cors: { origin: '*' }, // Allow all origins for Socket.IO
});

// ***** Game Logic (WebSocket + Game Loop)*******
let tournament = null;
let localTournament = null;
const game = new GameEngine();

// Initialize GameManager for room-based game isolation
let gameManager = null;

// Map of online users: socketId -> { userId, username, alias, blocked:Set }
const onlineUsers = new Map();

// Server startup cleanup
function initializeServer() {
	// Initialize GameManager
	gameManager = new GameManager(io);
	
	// Reset any existing tournament state on server restart
	if (tournament) {
		console.log('Server restart detected - resetting tournament state');
		tournament.reset();
		tournament = null;
	}
	if (localTournament) {
		console.log('Server restart detected - resetting local tournament state');
		localTournament.reset();
		localTournament = null;
	}
	// Reset game state before the game loop starts
	game.resetGame();
	// Ensure gameOver is false and score is zeroed before any game loop tick
	console.log('Server initialized - all states reset');
	console.log('GameManager initialized for room-based game isolation');
}

// Call initialization on server start
initializeServer();

// Local Tournament Game Loop
setInterval(() => {
	if (localTournament && localTournament.gameEngine) {
		const updatedState = localTournament.updateGame();
		if (updatedState && localTournament.socketId) {
			io.to(localTournament.socketId).emit('state_update', updatedState);
		}
	}
}, 16); // 60 FPS

// Improved countdown function with cleanup
function startSynchronizedCountdown(io, duration = 5) {
	let remaining = duration;
	
	// Clear any existing countdown
	if (countdownInterval) {
		clearInterval(countdownInterval);
		countdownInterval = null;
	}
	
	countdownInterval = setInterval(() => {
		io.emit('countdown_update', remaining);
		remaining--;
	
		if (remaining < 0) {
			clearInterval(countdownInterval);
			countdownInterval = null;

			setTimeout(() => {
				game.startMatch(); // Use GameEngine's method
				// Explicitly ensure game is unpaused for tournament
				game.paused = false;
				console.log('🎮 Tournament match started, game unpaused:', !game.paused);
				
				if (tournament && tournament.currentMatch) {
					const [p1, p2] = tournament.currentMatch;
					const alias1 = p1 && p1[1] && p1[1].alias ? p1[1].alias : 'Unknown';
					const alias2 = p2 && p2[1] && p2[1].alias ? p2[1].alias : 'Bye';
					console.log(`Match started ${alias1} vs ${alias2}`);
				}
				io.emit('start_match');
				// Send initial state update to start rendering immediately
				io.emit('state_update', game.getState());
				console.log('🎮 Initial state_update sent after tournament match start');
			}, 1000);
		}
	}, 1000);
	return countdownInterval;
}

io.on('connection', (socket) => {
	console.log('Client connected:', socket.id);
	
	// Detect game mode from client
	const isLocalMatch = 
		socket.handshake.query.local === 'true' ||
		socket.handshake.query.local === true;
	const gameMode = socket.handshake.query.mode || 'local';
	const isLocalTournament = gameMode === 'local_tournament';
	const isAIMode = gameMode === 'ai';
	const isTournamentMode = gameMode === 'tournament';
	
	console.log(`Setting game mode: ${gameMode}, isTournament: ${isTournamentMode}`);
	
	let roomId = null;
	let gameInstance = null;

	// Handle different game modes with room isolation
	if (isLocalMatch || isAIMode) {
		// Create a new local match room
		const { roomId: newRoomId, gameInstance: newGameInstance } = gameManager.createLocalMatch(socket.id, isAIMode);
		roomId = newRoomId;
		gameInstance = newGameInstance;
		
		// Join the room
		socket.join(roomId);
		gameManager.joinRoom(socket.id, roomId);
		
		// Add player to the game instance
		if (!gameInstance.addPlayer(socket.id)) {
			socket.emit('error', { message: 'Game is full' });
			socket.disconnect();
			return;
		}
		
		console.log(`AI Opponent ${isAIMode ? 'enabled' : 'disabled'}`);
		console.log(`Game mode set: ${gameMode}, isLocalMatch: ${isLocalMatch}, isTournament: ${isTournamentMode}, isAI: ${isAIMode}`);
		
		// Emit initial state to the room with debug info
		const gameState = gameInstance.gameEngine.getState();
		console.log(`🎮 Local match initial state - Ball moving: ${!gameState.ball || gameState.ball.vx !== 0 || gameState.ball.vy !== 0}, Paused: ${gameState.paused}, GameOver: ${gameState.gameOver}`);
		gameInstance.emitToRoom('state_update', gameState);
		
	} else if (isLocalTournament) {
		// Create a new local tournament room but don't start tournament yet
		// Wait for frontend to send player names via start_local_tournament event
		const { roomId: newRoomId, gameInstance: newGameInstance } = gameManager.createLocalTournament(socket.id);
		roomId = newRoomId;
		gameInstance = newGameInstance;
		
		// Join the room
		socket.join(roomId);
		gameManager.joinRoom(socket.id, roomId);
		
		// Don't add player or initialize tournament yet - wait for start_local_tournament event
		console.log(`Local tournament room created, waiting for player setup`);
		console.log(`AI Opponent disabled`);
		console.log(`Game mode set: ${gameMode}, isLocalMatch: false, isTournament: false, isAI: false`);
		
	} else if (isTournamentMode) {
		// Check if client might have been in a tournament before server restart
		if (!tournament) {
			socket.emit('tournament_reset', { 
				reason: 'Server was restarted during tournament. All tournament states have been cleared.' 
			});
		}
		
		console.log(`AI Opponent disabled`);
		console.log(`Game mode set: ${gameMode}, isLocalMatch: false, isTournament: ${isTournamentMode}, isAI: false`);
		
	} else {
		// Default case - use legacy system for backward compatibility
		game.setTournamentMode(isTournamentMode, gameMode);
		console.log(`Game mode set: ${gameMode}, isLocalMatch: ${isLocalMatch}, isTournament: ${isTournamentMode}, isAI: ${isAIMode}`);
		
		// Add player with error handling
		if (isLocalMatch || isAIMode) {
			if (!game.addPlayer(socket.id)) {
				socket.emit('error', { message: 'Game is full' });
				socket.disconnect();
				return;
			}
			console.log('Connected players:', Array.from(game.state.connectedPlayers));
		}
		
		console.log('✅ About to emit state_update for single player...');
		//Emit state_update after both players are present
		if (!isTournamentMode && game.state.connectedPlayers.size === 1) {
			io.emit('state_update', game.getState());
		}
		console.log('✅ State update emission completed');
	}

	console.log('✅ About to setup authenticate_chat handler...');
	socket.on('authenticate_chat', (token) => {
		if (!token) {
		socket.emit('auth_error', { message: 'Authentication token not provided.' });
		return;
		}
		try {
			const decoded = jwt.verify(token, getJWTSecret());

			// Prevent duplicate user sessions
			const isAlreadyOnline = [...onlineUsers.values()].some(user => user.userId === decoded.userId);
			if (isAlreadyOnline) {
				console.log(`User ${decoded.username} is already connected.`);
				// Filter out the current user from the list
				const onlineList = Array.from(onlineUsers.entries())
					.filter(([id, u]) => u.userId !== decoded.userId)
					.map(([id, u]) => ({ socketId: id, userId: u.userId, username: u.username, alias: u.alias }));
				socket.emit('online_users', onlineList);
				return;
			}

			const user = {
				userId: decoded.userId,
				username: decoded.username,
				alias: decoded.username,
				blocked: new Set(),
			};
			onlineUsers.set(socket.id, user); // <-- Add User
			console.log(`User authenticated for session: ${user.username} (${socket.id})`);

			// Notify all clients about the updated user list (excluding themselves)
			onlineUsers.forEach((_, socketId) => {
				const currentUser = onlineUsers.get(socketId);
				if (currentUser) {
					const onlineList = Array.from(onlineUsers.entries())
						.filter(([id, u]) => u.userId !== currentUser.userId)
						.map(([id, u]) => ({ 
							socketId: id, 
							alias: u.alias, 
							userId: u.userId, 
							username: u.username 
						}));
					
					io.to(socketId).emit('online_users', onlineList);
				}
			});
			console.log(`DEBUG: Broadcasting personalized online_users. Total unique users: ${onlineUsers.size}`);
		} catch (e) {
			console.error('Chat authentication failed:', e.message);
			socket.emit('auth_error', { message: 'Authentication failed' });
		}
	});

	socket.on('request_online_users', () => {
		const currentUser = onlineUsers.get(socket.id);
		if (currentUser) {
			const onlineList = Array.from(onlineUsers.entries())
				.filter(([id, u]) => u.userId !== currentUser.userId)
				.map(([id, u]) => ({ 
					socketId: id, 
					alias: u.alias, 
					userId: u.userId, 
					username: u.username 
				}));
			
			socket.emit('online_users', onlineList);
		}
	});

	socket.on('player_move', ({ direction, playerId }) => {
		// Get the socket's room and game instance
		const gameInstance = gameManager.getGameInstance(socket.id);
		if (gameInstance) {
			gameInstance.gameEngine.handlePlayerInput(playerId, direction);
			gameInstance.emitToRoom('state_update', gameInstance.gameEngine.getState());
		} else {
			// Fallback to legacy system
			game.handlePlayerInput(playerId, direction);
			io.emit('state_update', game.getState());
		}
	});
	
	socket.on('restart_game', () => {
		const gameInstance = gameManager.getGameInstance(socket.id);
		if (gameInstance) {
			gameInstance.gameEngine.resetGame();
			gameInstance.gameEngine.resume();
			gameInstance.emitToRoom('state_update', gameInstance.gameEngine.getState());
		} else {
			// Fallback to legacy system
			game.resetGame();
			game.resume();
			io.emit('state_update', game.getState());
		}
	});

	// Pause/Resume functionality
	socket.on('pause_game', () => {
		const gameInstance = gameManager.getGameInstance(socket.id);
		if (gameInstance) {
			gameInstance.gameEngine.pause();
			gameInstance.emitToRoom('game_paused');
			console.log('Game paused by player:', socket.id, 'in room:', gameInstance.roomId);
		} else {
			// Fallback to legacy system
			game.pause();
			io.emit('game_paused');
			console.log('Game paused by player:', socket.id);
		}
	});

	socket.on('resume_game', () => {
		const gameInstance = gameManager.getGameInstance(socket.id);
		if (gameInstance) {
			gameInstance.gameEngine.resume();
			gameInstance.emitToRoom('game_resumed');
			console.log('Game resumed by player:', socket.id, 'in room:', gameInstance.roomId);
		} else {
			// Fallback to legacy system
			game.resume();
			io.emit('game_resumed');
			console.log('Game resumed by player:', socket.id);
		}
	});

	// Remote tournament pause/resume functionality
	socket.on('tournament_pause', () => {
		if (tournament && tournament.currentMatch) {
			game.pause();
			// Notify only the players in the current match
			const { player1, player2 } = tournament.getCurrentMatchPlayers();
			if (player1) io.to(player1.socketId).emit('tournament_paused');
			if (player2) io.to(player2.socketId).emit('tournament_paused');
			console.log('Tournament game paused by player:', socket.id);
		}
	});

	socket.on('tournament_resume', () => {
		if (tournament && tournament.currentMatch) {
			game.resume();
			// Notify only the players in the current match
			const { player1, player2 } = tournament.getCurrentMatchPlayers();
			if (player1) io.to(player1.socketId).emit('tournament_resumed');
			if (player2) io.to(player2.socketId).emit('tournament_resumed');
			console.log('Tournament game resumed by player:', socket.id);
		}
	});

	// ***new: added token + data for Match Data***
	socket.on('register_alias', ({ alias, token }) => { // + token
		if (!token) {
			socket.emit('alias_registered', { success: false, message: 'Authentication required.' });
			return;
		}

		try {
			const decodedToken = jwt.verify(token, getJWTSecret());
			const user = { userId: decodedToken.userId, username: decodedToken.username };

			if (!tournament) tournament = new Tournament();
		
			const success = tournament.registerPlayer(socket.id, alias, user);
			
			if (success) {
				// *** i deleted this part because onlineUsers is already populated in authenticate_chat, in Dashboard ***
				socket.emit('alias_registered', { success: true });
				// onlineUsers.set(socket.id, { userId: user.userId, username: user.username, alias, blocked: new Set() });
				// const onlineList = Array.from(onlineUsers.entries()).map(([id, u]) => ({ socketId: id, alias: u.alias, userId: u.userId, username: u.username }));
				// io.emit('online_users', onlineList);

				const playerList = Array.from(tournament.players.entries()).map(([socketId, {alias, userId, username}]) => ({
					socketId,
					alias,
					userId,
					username
				}));
				io.emit('player_list_updated', playerList);

				console.log('Players in lobby:', Array.from(tournament.players.values()).map(p => p.alias)); // Del
				
				// Only show the lobby dialog, do not start the match yet
				io.emit('tournament_lobby', {
					message: tournament.canStartTournament() && tournament.rounds.length === 0
						? 'Ready to start tournament?'
						: 'Waiting for more players to join...',
					players: Array.from(tournament.players.values()).map(p => p.alias)
				});
			} else {
				// Check if it's a duplicate user or duplicate alias
				const existingUserIds = [...tournament.players.values()].map(p => p.userId);
				const existingAliases = [...tournament.players.values()].map(p => p.alias);
				
				if (existingUserIds.includes(user.userId)) {
					socket.emit('alias_registered', { success: false, message: 'You are already registered in this tournament.' });
				} else if (existingAliases.includes(alias)) {
					socket.emit('alias_registered', { success: false, message: 'Alias already taken. Please choose another name.' });
				} else {
					socket.emit('alias_registered', { success: false, message: 'Registration failed.' });
				}
			}
		} catch (e) {
			socket.emit('alias_registered', { success: false, message: 'Invalid token.' });
		}
	});


	socket.on('leave_tournament', () => {
		if (tournament && tournament.players.has(socket.id)) {
			const player = tournament.players.get(socket.id);
			console.log(`Player ${player?.alias} leaving tournament`);

			// Remove player from tournament
			tournament.removePlayer(socket.id);

			// Update player list for remaining players
			const playerList = Array.from(tournament.players.entries()).map(([socketId, {alias, userId, username}]) => ({
				socketId,
				alias,
				userId,
				username
			}));

			io.emit('player_list_updated', playerList);

			// Update lobby status
			if (tournament.players.size === 0) {
				// No players left, reset tournament
				tournament.reset();
				tournament = null;
				io.emit('tournament_lobby_closed');
			} else {
				// Update lobby message for remaining players
				io.emit('tournament_lobby', {
				message: tournament.canStartTournament() && tournament.rounds.length === 0
					? 'Ready to start tournament?'
					: 'Waiting for more players to join...',
				players: Array.from(tournament.players.values()).map(p => p.alias)
			});
		}

		// Remove from online users alias
		const user = onlineUsers.get(socket.id);
		if (user) {
			delete user.alias;
			onlineUsers.set(socket.id, user);
		}

		// Update online users list
		const onlineList = Array.from(onlineUsers.entries()).map(([id, u]) => ({
			socketId: id,
			alias: u.alias,
			userId: u.userId,
			username: u.username
		}));
		io.emit('online_users', onlineList);
	}
});

socket.on('player_inactive', () => {
	// Optional: Handle tab switching - you might want to keep player registered
	// or remove them after a timeout
	console.log(`Player ${socket.id} became inactive`);
});

	socket.on('private_message', async ({ targetSocketId, message }) => { // Make handler async
			const sender = onlineUsers.get(socket.id);
			const recipient = onlineUsers.get(targetSocketId);
			if (!sender || !recipient) return;
			if (recipient.blocked && recipient.blocked.has(sender.userId)) return;

			try {
				await DB('chat_messages').insert({
					sender_id: sender.userId,
					recipient_id: recipient.userId,
					message_text: message
				});
			} catch (error) {
				console.error('Failed to save chat message:', error);
			}

			io.to(targetSocketId).emit('private_message', { from: socket.id, message, username: sender.username, userId: sender.userId });
	});

	socket.on('block_user', ({ targetUserId }) => {
			const user = onlineUsers.get(socket.id);
			if (user) {
					user.blocked.add(targetUserId);
					// Notify the client that the user was blocked
					socket.emit('user_blocked', { targetUserId, message: `You have blocked this user.` });
			}
	});

	socket.on('unblock_user', ({ targetUserId }) => {
			const user = onlineUsers.get(socket.id);
			if (user) {
				user.blocked.delete(targetUserId);
				// Notify the client that the user was unblocked
				socket.emit('user_unblocked', { targetUserId, message: `You have unblocked this user.` });
			}
	});

	socket.on('invite_to_game', ({ targetSocketId }) => {
			const sender = onlineUsers.get(socket.id);
			if (!sender) return;
			io.to(targetSocketId).emit('game_invite', { from: socket.id, alias: sender.alias, userId: sender.userId });
	});

	// Administrative tournament reset - can be triggered for testing or emergency cleanup
	socket.on('admin_reset_tournament', ({ token }) => {
		if (!token) return;
		
		try {
			const decodedToken = jwt.verify(token, getJWTSecret());
			// Add admin check here if needed - for now any authenticated user can reset
			
			console.log(`Tournament reset requested by user ${decodedToken.username} (${socket.id})`);
			
			if (tournament) {
				// Cancel any active countdown
				if (countdownInterval) {
					clearInterval(countdownInterval);
					countdownInterval = null;
					io.emit('countdown_cancelled');
				}
				
				// Notify all clients about the reset
				io.emit('tournament_reset', { 
					reason: 'Tournament was manually reset by administrator' 
				});
				
				// Reset tournament state
				tournament.reset();
				tournament = null;
				
				// Reset game state
				game.resetGame();
				game.pause();
				
				console.log('Tournament has been manually reset');
			} else {
				socket.emit('admin_response', { message: 'No active tournament to reset' });
			}
		} catch (e) {
			socket.emit('admin_response', { message: 'Invalid authentication for admin action' });
		}
	});


	socket.on('send_public_tournament_invite', ({ targetSocketId }) => {
		console.log(`[DEBUG] Tournament invite request from ${socket.id} to ${targetSocketId}`);
		
		const sender = onlineUsers.get(socket.id);
		const recipient = onlineUsers.get(targetSocketId);

		if (!sender || !recipient) {
			console.log(`[DEBUG] Could not find sender or recipient for tournament invite. Sender: ${sender ? sender.alias : 'null'}, Recipient: ${recipient ? recipient.alias : 'null'}`);
			return;
		}

		const payload = {
			senderAlias: sender.alias,
			senderSocketId: socket.id
		};

		console.log(`[DEBUG] Sending tournament invite from ${sender.alias} to ${recipient.alias}. Payload:`, payload);

		// Send the special invite message to both users' chat windows
		io.to(socket.id).emit('receive_public_tournament_invite', payload);
		io.to(targetSocketId).emit('receive_public_tournament_invite', payload);
		
		console.log(`[DEBUG] Tournament invite sent successfully`);
	});

	socket.on('dismiss_lobby_invite', ({ senderSocketId }) => {
		const sender = onlineUsers.get(senderSocketId);
		if (sender) {
			io.to(senderSocketId).emit('lobby_invite_dismissed', { message: 'Your match invite was dismissed.' });
		}
	});

	socket.on('accept_lobby_invite', ({ senderSocketId }) => {
		const sender = onlineUsers.get(senderSocketId);
		const accepter = onlineUsers.get(socket.id);
		
		if (sender && accepter) {
			// Notify the original sender that their invite was accepted
			io.to(senderSocketId).emit('lobby_invite_accepted', { 
				accepterAlias: accepter.alias,
				accepterSocketId: socket.id
			});
			
			// Optionally notify the accepter too
			socket.emit('lobby_invite_accepted', { 
				senderAlias: sender.alias,
				senderSocketId: senderSocketId
			});
			
			console.log(`${accepter.alias} accepted lobby invite from ${sender.alias}`);
		} else {
			console.log('Could not find sender or accepter for lobby invite acceptance.');
		}
	});

	// Start tournament when someone clicks "Start Tournament"
	socket.on('start_tournament', () => {
		if (!tournament) return;
		
		if (tournament.rounds.length === 0) {
			try {
				tournament.generateInitialBracket();
				console.log('Tournament bracket generated successfully');
			} catch (e) {
				// Notify the client about the error, do not crash the server
				socket.emit('tournament_error', { message: e.message });
				tournament.reset(); // ***new: Reset the tournament state
				io.emit('tournament_cancelled'); // ***new: Notify clients
				return;
			}
			
			const currentMatch = tournament.getCurrentMatchPlayers();
			console.log('Current match players:', {
				player1: currentMatch.player1 ? `${currentMatch.player1.alias} (${currentMatch.player1.socketId})` : null,
				player2: currentMatch.player2 ? `${currentMatch.player2.alias} (${currentMatch.player2.socketId})` : null
			});
			
			game.prepareForMatch();
			
			// Emit the dynamic bracket to all clients
			const dynamicBracket = tournament.getDynamicBracket();
			io.emit('tournament_bracket', dynamicBracket);
			
			io.emit('match_announcement', {
				player1: currentMatch.player1.alias,
				player2: currentMatch.player2 ? currentMatch.player2.alias : 'Bye'
			});
			
			// Send ready prompt only to the players in the current match
			if (currentMatch.player1) {
				io.to(currentMatch.player1.socketId).emit('await_player_ready');
			}
			if (currentMatch.player2) {
				io.to(currentMatch.player2.socketId).emit('await_player_ready');
			}
		}
	});

	socket.on('player_ready', () => {
		if (!tournament) return;
		
		const player = tournament.players.get(socket.id);
		console.log(`Player ready: ${player ? player.alias : 'Unknown'} (${socket.id})`);
		
		tournament.markPlayerReady(socket.id);
		
		const currentMatch = tournament.getCurrentMatchPlayers();
		console.log('Current match ready status:', {
			player1: currentMatch.player1 ? `${currentMatch.player1.alias}: ${currentMatch.player1.isReady}` : null,
			player2: currentMatch.player2 ? `${currentMatch.player2.alias}: ${currentMatch.player2.isReady}` : null,
			allReady: tournament.allPlayersReady()
		});
	
		if (tournament.allPlayersReady() ) {
			console.log('All players ready! Starting countdown...');
			const currentMatch = tournament.getCurrentMatchPlayers();
			if (currentMatch.player1) 
				io.to(currentMatch.player1.socketId).emit('assign_controls', 'player1');
			if (currentMatch.player2)
				io.to(currentMatch.player2.socketId).emit('assign_controls', 'player2');
				startSynchronizedCountdown(io);
		}
	});

	socket.on('host_start_next_match', () => {
		if (!tournament) return;

		// Only allow host to trigger
		const { player1, player2 } = tournament.getCurrentMatchPlayers();
		if (!player1 || socket.id !== player1.socketId) return;

		// Reset ready state for both players
		tournament.resetPlayersReady(player1.socketId, player2 && player2.socketId);

		game.resetGame();

		// Emit the reset state to all clients
		io.emit('state_update', game.getState());

		// Debug log: show which sockets will receive the event
		console.log('Emitting await_player_ready to:', player1.socketId, player2 && player2.socketId);

		// Now prompt both players to get ready
		io.to(player1.socketId).emit('await_player_ready');
		if (player2) io.to(player2.socketId).emit('await_player_ready');
	});
	
	socket.on('match_ended', async ({ winnerSocketId }) => {
		if (!tournament?.currentMatch) {
			console.warn('match_ended received but no current match');
			return;
		}

		const state = game.getState();
		if (state.score.player1 === 0 && state.score.player2 === 0) {
			console.warn('Ignoring match_ended: no score change');
			return;
		}

		// *** FIX: Capture match data BEFORE advancing the tournament ***
		const { player1, player2 } = tournament.getCurrentMatchPlayers();
		const winner = winnerSocketId === player1.socketId ? player1 : player2;
		
		if (player1 && player2) {
			try {
				const matchDataToSave = {
					player1_id: player1.userId,
					player2_id: player2.userId,
					player1_username: player1.alias,
					player2_username: player2.alias,
					player1_score: state.score.player1,
					player2_score: state.score.player2,
					winner_id: winner.userId,
					winner_username: winner.alias,
					is_tournament: true,
				};
				console.log('[DEBUG] Saving match data to DB:', matchDataToSave);
				await DB('matchHistory').insert(matchDataToSave);
				console.log('Match history saved successfully.');
			} catch (error) {
				console.error('Failed to save match history:', error);
			}
		}

		// Now, advance the tournament to the next match
		const gameScores = { player1: state.score.player1, player2: state.score.player2 };
		let nextMatch = tournament.recordWinner(winnerSocketId, gameScores);

		// Loop to skip byes and auto-advance until a real match or tournament end
		while (nextMatch && (!nextMatch[0] || !nextMatch[1])) {
			const autoWinner = nextMatch[0] ? nextMatch[0][0] : nextMatch[1][0];
			nextMatch = tournament.recordWinner(autoWinner); // No scores for bye matches
		}

		if (nextMatch) {
			const { player1: nextP1, player2: nextP2 } = tournament.getCurrentMatchPlayers();
			game.prepareForMatch();

			// Reset readiness for the new match
			tournament.resetReadyForCurrentMatch();

			// Emit updated bracket after match completion
			const dynamicBracket = tournament.getDynamicBracket();
			io.emit('tournament_bracket', dynamicBracket);

			if (nextP1 && nextP2) {
				io.emit('match_announcement', { 
					player1: nextP1.alias,
					player2: nextP2.alias
				});
				io.to(nextP1.socketId).emit('await_player_ready');
				io.to(nextP2.socketId).emit('await_player_ready');
			}
		} else {
			const finalWinnerData = tournament.winners[0];
			const finalWinnerAlias = finalWinnerData && finalWinnerData[1] ? finalWinnerData[1] : 'Unknown';
			const allMatchResults = tournament.getAllMatchResults();
				// Emit the final bracket with completed state and champion before tournament_over
				const finalBracket = tournament.getDynamicBracket();
				io.emit('tournament_bracket', finalBracket);
				io.emit('tournament_over', { 
					winner: finalWinnerAlias,
					allMatches: allMatchResults 
				});
				tournament.reset(); // Reset for the next tournament
		}
	});

	// ===== LOCAL TOURNAMENT HANDLERS =====
	
	socket.on('init_local_tournament', ({ playerNames }) => {
		try {
			if (!localTournament) {
				localTournament = new LocalTournamentMode();
			}
			
			localTournament.initializeTournament(socket.id, playerNames);
			localTournament.generateInitialBracket();
			
			const status = localTournament.getTournamentStatus();
			socket.emit('local_tournament_initialized', status);
			console.log(`Local tournament initialized with ${playerNames.length} players`);
		} catch (error) {
			socket.emit('local_tournament_error', { message: error.message });
		}
	});

	// New handler for starting tournament with player names (using GameManager)
	socket.on('start_local_tournament', ({ playerNames }) => {
		try {
			const gameInstance = gameManager.getGameInstance(socket.id);
			if (gameInstance && gameInstance.type === 'local_tournament') {
				// Add the player to the tournament instance
				gameInstance.addPlayer(socket.id);
				// Start the tournament with the provided player names
				gameInstance.startTournament(socket.id, playerNames);
				console.log(`✅ Local tournament started with players:`, playerNames);
			} else {
				throw new Error('No local tournament instance found for this socket');
			}
		} catch (error) {
			socket.emit('local_tournament_error', { message: error.message });
		}
	});

	socket.on('start_local_tournament_match', () => {
		try {
			// Use room-based tournament system
			const gameInstance = gameManager.getGameInstance(socket.id);
			if (gameInstance && gameInstance.type === 'local_tournament') {
				const tournament = gameInstance.localTournament;
				
				// Check if there's already an active game (match already started)
				if (tournament && tournament.gameEngine && !tournament.gameEngine.state.gameOver) {
					console.log('⚠️ Match already started, sending current game state');
					gameInstance.emitToRoom('state_update', tournament.getGameState());
					return;
				}
				
				if (!tournament || !tournament.currentMatch) {
					throw new Error('No active local tournament match in room');
				}

				// Start the current match using the new method
				const matchResult = gameInstance.startCurrentMatch();
				
				if (matchResult && matchResult.gameState) {
					// Real match, not a bye
					gameInstance.emitToRoom('local_tournament_match_started', matchResult);
					gameInstance.emitToRoom('state_update', matchResult.gameState);
					console.log(`✅ Local tournament match started in room: ${gameInstance.roomId}`);
				} else {
					// Bye match was handled automatically, get updated status
					const status = tournament.getTournamentStatus();
					gameInstance.emitToRoom('local_tournament_status_update', status);
				}
			} else if (localTournament && localTournament.currentMatch) {
				// Fallback to legacy system
				console.log('⚠️ Using legacy tournament match start');
				const matchInfo = localTournament.startCurrentMatch();
				
				if (matchInfo && matchInfo.gameState) {
					socket.emit('local_tournament_match_started', matchInfo);
					socket.emit('state_update', matchInfo.gameState);
				} else {
					const status = localTournament.getTournamentStatus();
					socket.emit('local_tournament_status_update', status);
				}
			} else {
				throw new Error('No active local tournament match');
			}
		} catch (error) {
			socket.emit('local_tournament_error', { message: error.message });
		}
	});

	socket.on('local_tournament_player_move', ({ direction, playerId }) => {
		try {
			// Use room-based tournament system
			const gameInstance = gameManager.getGameInstance(socket.id);
			if (gameInstance && gameInstance.type === 'local_tournament') {
				const tournament = gameInstance.localTournament;
				if (!tournament || !tournament.gameEngine) {
					console.log('⚠️ No tournament gameEngine in room-based instance');
					return;
				}

				tournament.handleGameInput({ direction, playerId });
				gameInstance.emitToRoom('state_update', tournament.getGameState());
				//console.log(`🎮 Local tournament move in room ${gameInstance.roomId}: ${direction} by ${playerId}`);
			} else if (localTournament && localTournament.gameEngine) {
				// Fallback to legacy system
				console.log('⚠️ Using legacy tournament player move');
				localTournament.handleGameInput({ direction, playerId });
				socket.emit('state_update', localTournament.getGameState());
			}
		} catch (error) {
			console.error('Local tournament player move error:', error.message);
			socket.emit('local_tournament_error', { message: error.message });
		}
	});

	// Local tournament pause/resume functionality
	socket.on('local_tournament_pause', () => {
		try {
			const gameInstance = gameManager.getGameInstance(socket.id);
			console.log(`🔍 Local tournament pause - gameInstance found:`, !!gameInstance);
			console.log(`🔍 gameInstance type:`, gameInstance?.type);
			console.log(`🔍 gameEngine exists:`, !!gameInstance?.gameEngine);
			
			if (gameInstance && gameInstance.type === 'local_tournament') {
				if (gameInstance.gameEngine) {
					gameInstance.gameEngine.pause();
					gameInstance.emitToRoom('local_tournament_paused');
					console.log('✅ Local tournament game paused by player:', socket.id, 'in room:', gameInstance.roomId);
				} else {
					console.log('⚠️ No gameEngine available in tournament instance');
					gameInstance.emitToRoom('local_tournament_paused');
				}
			} else if (localTournament && localTournament.gameEngine) {
				// Fallback to legacy system
				console.log('⚠️ Falling back to legacy tournament system');
				localTournament.gameEngine.pause();
				socket.emit('local_tournament_paused');
				console.log('Local tournament game paused by player:', socket.id);
			} else {
				console.log('❌ No tournament instance found - neither room-based nor legacy');
			}
		} catch (error) {
			console.error('Local tournament pause error:', error.message);
		}
	});

	socket.on('local_tournament_resume', () => {
		try {
			const gameInstance = gameManager.getGameInstance(socket.id);
			if (gameInstance && gameInstance.type === 'local_tournament' && gameInstance.gameEngine) {
				gameInstance.gameEngine.resume();
				gameInstance.emitToRoom('local_tournament_resumed');
				console.log('Local tournament game resumed by player:', socket.id, 'in room:', gameInstance.roomId);
			} else if (localTournament && localTournament.gameEngine) {
				// Fallback to legacy system
				localTournament.gameEngine.resume();
				socket.emit('local_tournament_resumed');
				console.log('Local tournament game resumed by player:', socket.id);
			}
		} catch (error) {
			console.error('Local tournament resume error:', error.message);
		}
	});

	socket.on('local_tournament_match_ended', ({ winnerId, scores }) => {
		try {
			const gameInstance = gameManager.getGameInstance(socket.id);
			if (gameInstance && gameInstance.type === 'local_tournament') {
				const nextMatch = gameInstance.tournamentMode.recordWinner(winnerId, scores);
				const status = gameInstance.tournamentMode.getTournamentStatus();

				if (gameInstance.tournamentMode.isFinished) {
					gameInstance.emitToRoom('local_tournament_finished', {
						winner: status.winner,
						allMatches: status.matchHistory,
						bracket: status.bracket
					});
				} else if (nextMatch) {
					gameInstance.emitToRoom('local_tournament_next_match', {
						match: gameInstance.tournamentMode.getCurrentMatchPlayers(),
						status: status
					});
				} else {
					gameInstance.emitToRoom('local_tournament_error', { message: 'No next match available' });
				}
			} else if (localTournament) {
				// Fallback to legacy system
				const nextMatch = localTournament.recordWinner(winnerId, scores);
				const status = localTournament.getTournamentStatus();

				if (localTournament.isFinished) {
					socket.emit('local_tournament_finished', {
						winner: status.winner,
						allMatches: status.matchHistory,
						bracket: status.bracket
					});
				} else if (nextMatch) {
					socket.emit('local_tournament_next_match', {
						match: localTournament.getCurrentMatchPlayers(),
						status: status
					});
				} else {
					socket.emit('local_tournament_error', { message: 'No next match available' });
				}
			} else {
				throw new Error('No active local tournament');
			}
		} catch (error) {
			socket.emit('local_tournament_error', { message: error.message });
		}
	});

	socket.on('get_local_tournament_status', () => {
		const gameInstance = gameManager.getGameInstance(socket.id);
		if (gameInstance && gameInstance.type === 'local_tournament') {
			const status = gameInstance.tournamentMode.getTournamentStatus();
			gameInstance.emitToRoom('local_tournament_status_update', status);
		} else if (localTournament) {
			// Fallback to legacy system
			const status = localTournament.getTournamentStatus();
			socket.emit('local_tournament_status_update', status);
		} else {
			socket.emit('local_tournament_error', { message: 'No active local tournament' });
		}
	});

	socket.on('reset_local_tournament', () => {
		if (localTournament) {
			localTournament.reset();
			localTournament = null;
			socket.emit('local_tournament_reset');
			console.log('Local tournament reset');
		}
	});



	// ===== END LOCAL TOURNAMENT HANDLERS =====

	socket.on('disconnect', () => {
		console.log('Client disconnected:', socket.id);
		
		// Clean up room-based games first
		gameManager.handleDisconnect(socket.id);
		
		// Legacy cleanup
		game.removePlayer(socket.id);
		onlineUsers.delete(socket.id);
		const onlineList = Array.from(onlineUsers.entries()).map(([id, u]) => ({ socketId: id, alias: u.alias, userId: u.userId, username: u.username }));
		io.emit('online_users', onlineList);

		if (tournament) {
			const disconnectedPlayer = tournament.players.get(socket.id);
			
			// If player is not in tournament, skip tournament logic
			if (!disconnectedPlayer) {
				return;
			}
			
			console.log(`Tournament player ${disconnectedPlayer.alias} (${socket.id}) disconnecting. Tournament finished: ${tournament.isFinished}, Players remaining: ${tournament.players.size}`);
			
			// If tournament is already finished, just clean up silently
			if (tournament.isFinished) {
				console.log('Tournament already finished, removing player silently');
				tournament.removePlayer(socket.id);
				
				// Only reset tournament when ALL players have left a finished tournament
				if (tournament.players.size === 0) {
					console.log('All players left finished tournament, cleaning up');
					tournament.reset();
				}
				return; // Exit early for finished tournaments
			}
			
			// Cancel any active countdown if a tournament player disconnects
			if (countdownInterval) {
				clearInterval(countdownInterval);
				countdownInterval = null;
				io.emit('countdown_cancelled');
			}
			
			// Check if current match player disconnected
			if (tournament.currentMatch) {
				const [p1, p2] = tournament.currentMatch;
				const isPlayerInMatch = socket.id === p1[0] || socket.id === p2?.[0];
				
				if (isPlayerInMatch) {
					console.log('Player in match disconnected:', socket.id, 'Match:', p1, p2);
					
					// Determine the winner (the opponent who didn't disconnect)
					const winnerSocketId = socket.id === p1[0] ? p2?.[0] : p1[0];
					const winnerData = winnerSocketId ? tournament.players.get(winnerSocketId) : null;
					const loserAlias = disconnectedPlayer?.alias || 'Unknown Player';
					
					console.log('Forfeit details:', { winnerSocketId, winnerData: winnerData?.alias, loserAlias });
					
					if (winnerData && winnerSocketId) {
						try {
							// First, pause the game to stop any ongoing match
							game.paused = true;
							game.resetGame();
							
							// Record the forfeit victory with forfeit scores
							const forfeitScores = { 
								player1: socket.id === p1[0] ? 0 : 5, 
								player2: socket.id === p2?.[0] ? 0 : 5 
							};
							
							// Don't remove the disconnected player yet - recordWinner needs to validate
							let nextMatch = tournament.recordWinner(winnerSocketId, forfeitScores);
							
							// Loop to skip byes and auto-advance until a real match or tournament end
							while (nextMatch && (!nextMatch[0] || !nextMatch[1])) {
								const autoWinner = nextMatch[0] ? nextMatch[0][0] : nextMatch[1][0];
								nextMatch = tournament.recordWinner(autoWinner); // No scores for bye matches
							}
							
							io.emit('match_forfeit', {
								winner: winnerData.alias,
								loser: loserAlias,
								reason: 'Player disconnected'
							});
							
							// Update bracket display
							const bracket = tournament.getDynamicBracket();
							io.emit('tournament_bracket', bracket);
							
							// Add delay to show forfeit message before proceeding
							setTimeout(() => {
								// Remove player from tournament AFTER forfeit processing
								tournament.removePlayer(socket.id);
								
								if (tournament.isFinished) {
									const finalWinnerAlias = tournament.tournamentWinner?.[1] || 'Unknown';
									const allMatchResults = tournament.getAllMatchResults();
									io.emit('tournament_over', { 
										winner: finalWinnerAlias,
										allMatches: allMatchResults 
									});
									tournament.reset();
								} else if (nextMatch) {
									// Announce the next match using the same logic as match_ended
									const { player1: nextP1, player2: nextP2 } = tournament.getCurrentMatchPlayers();
									game.prepareForMatch();
									
									// Reset readiness for the new match
									tournament.resetReadyForCurrentMatch();
									
									if (nextP1 && nextP2) {
										io.emit('match_announcement', { 
											player1: nextP1.alias,
											player2: nextP2.alias
										});
										io.to(nextP1.socketId).emit('await_player_ready');
										io.to(nextP2.socketId).emit('await_player_ready');
									}
								} else {
									// Check if this was the final match (only 1 player left after disconnect)
									if (tournament.players.size === 1) {
										// If only 1 player remains and tournament was in progress, they win by forfeit
										const remainingPlayer = Array.from(tournament.players.values())[0];
										if (remainingPlayer) {
											tournament.isFinished = true;
											tournament.tournamentWinner = [remainingPlayer.userId, remainingPlayer.alias];
											const allMatchResults = tournament.getAllMatchResults();
											io.emit('tournament_over', { 
												winner: remainingPlayer.alias,
												allMatches: allMatchResults 
											});
											tournament.reset();
										}
									} else if (tournament.players.size < 2 && !tournament.isFinished) {
										// Less than 2 players and tournament not finished = cancel
										tournament.reset();
										io.emit('tournament_cancelled', {
											reason: 'Not enough players remaining'
										});
									} else if (tournament.players.size === 0 && tournament.isFinished) {
										// All players have left a finished tournament, clean up
										tournament.reset();
									}
								}
							}, 3000); // 3 second delay to show forfeit message
						} catch (error) {
							console.error('Error handling forfeit:', error);
							game.paused = true;
							game.resetGame();
							io.emit('match_cancelled', {
								reason: 'Error processing forfeit: ' + error.message
							});
							// Remove player even on error
							tournament.removePlayer(socket.id);
						}
					} else {
						// No valid opponent found, cancel match
						console.log('No valid opponent found for forfeit:', { winnerSocketId, winnerData: winnerData?.alias, p1, p2 });
						game.paused = true;
						game.resetGame();
						io.emit('match_cancelled', {
							reason: 'Player disconnected, no valid opponent'
						});
						// Remove player when no opponent found
						tournament.removePlayer(socket.id);
					}
				} else {
					// Player disconnected but not in current match - just remove them
					tournament.removePlayer(socket.id);
					
					// Check if tournament should continue or be cancelled
					if (tournament.players.size === 1) {
						// If only 1 player remains and tournament was in progress, they win by forfeit
						const remainingPlayer = Array.from(tournament.players.values())[0];
						if (remainingPlayer) {
							tournament.isFinished = true;
							tournament.tournamentWinner = [remainingPlayer.userId, remainingPlayer.alias];
							const allMatchResults = tournament.getAllMatchResults();
							io.emit('tournament_over', { 
								winner: remainingPlayer.alias,
								allMatches: allMatchResults 
							});
							tournament.reset();
						}
					} else if (tournament.players.size < 2 && !tournament.isFinished) {
						// Less than 2 players and tournament not finished = cancel
						tournament.reset();
						io.emit('tournament_cancelled', {
							reason: 'Not enough players remaining'
						});
					} else if (tournament.players.size === 0 && tournament.isFinished) {
						// All players have left a finished tournament, clean up
						tournament.reset();
					}
				}
			} else {
				// No current match - just remove the player
				tournament.removePlayer(socket.id);
				
				// Check if tournament should continue or be cancelled  
				if (tournament.players.size === 1) {
					const remainingPlayer = Array.from(tournament.players.values())[0];
					if (remainingPlayer) {
						tournament.isFinished = true;
						tournament.tournamentWinner = [remainingPlayer.userId, remainingPlayer.alias];
						const allMatchResults = tournament.getAllMatchResults();
						io.emit('tournament_over', { 
							winner: remainingPlayer.alias,
							allMatches: allMatchResults 
						});
						tournament.reset();
					}
				} else if (tournament.players.size < 2 && !tournament.isFinished) {
					tournament.reset();
					io.emit('tournament_cancelled', {
						reason: 'Not enough players remaining'
					});
				} else if (tournament.players.size === 0 && tournament.isFinished) {
					// All players have left a finished tournament, clean up
					tournament.reset();
				}
			}
		}
	});
});

// Game loop
setInterval(() => {
	// Only run the game loop if both players are connected and game is not paused
	// For tournament mode, also check if tournament exists and has current match
	const shouldRunGameLoop = !game.paused && 
		((game.state.connectedPlayers && game.state.connectedPlayers.size === 2) ||
		 (tournament && tournament.currentMatch && tournament.getCurrentMatchPlayers().player1 && tournament.getCurrentMatchPlayers().player2));
		 
	if (shouldRunGameLoop) {
		game.update(1 / 60);
		const state = game.getState();
		io.emit('state_update', game.getState());
		if (state.gameOver) {
			console.log('Game over! Final score:', state.score);
			game.paused = true;
			// Don't reset immediately in tournament mode - let match_ended handler do it
			if (!tournament || !tournament.currentMatch) {
				game.resetGame(); // Only reset for non-tournament games
			}
		}
	}
}, 1000 / 60); // 60 times per second

// --- Middlewares ---
app.register(fastifyCors, { origin: true, credentials: true });

// Register Multipart plugin
app.register(multipart, { // Now 'multipart' is defined
	// attachFieldsToBody: true,
	limits: {
	fileSize: 7 * 1024 * 1024, // 7MB
	}
});

app.register(fastifyFormbody);

// Serve uploaded avatars
app.register(fastifyStatic, {
	root: avatarsDir,
	prefix: '/uploads/avatars/', // URL prefix to access these files
	decorateReply: false // To avoid conflict if already decorated for other static serving
});

// Serve frontend static files
app.register(fastifyStatic, {
	root: join(__dirname, '../frontend/dist'), // Path to compiled frontend
	prefix: '/',
});


//--------Routes------------
developerRoutes(app);
credentialsRoutes(app);

// noHandlerRoute(app);
//-------------------------

// Fallback for SPA routing
app.setNotFoundHandler((req, reply) => {
	reply.sendFile('index.html'); // Serve index.html from the root specified in fastifyStatic
});



// --- Start Server ---
const start =  async () => {
	try{
		const address = await app.listen({ port: PORT, host: HOST });
		// console.log("Server running " + address)
		console.log(`Access to school ${process.env.APP_URL}`)
	}
	catch (e){
		console.error('❌ Error in start function:', e);
		app.log.error(e);
		process.exit(1);
	}

}

start();