import { Socket } from 'socket.io-client';
import './chat.css';

interface OnlineUser {
  socketId: string;
  userId: number;
  username: string;
  isBlocked?: boolean; // Add this to track block status
}

export function renderChat(socket: Socket): () => void {
  let selectedUser: OnlineUser | null = null; // selectedUser is now local to the render function
  let blockedUserIds = new Set<number>(); // Keep track of blocked user IDs

  const container = document.createElement('div');
  container.className = 'chat-container';

  // Create a wrapper for the player list and its title
  const playerListContainer = document.createElement('div');
  playerListContainer.className = 'player-list-container';

  const playerListTitle = document.createElement('h3');
  playerListTitle.textContent = 'ONLINE USERS';
  playerListTitle.className = 'player-list-title';

  const playerList = document.createElement('ul');
  playerList.className = 'chat-player-list';

  // Add the title and the list to their container
  playerListContainer.appendChild(playerListTitle);
  playerListContainer.appendChild(playerList);

  const chatArea = document.createElement('div');
  chatArea.className = 'chat-area';

  const messagesDiv = document.createElement('div');
  messagesDiv.className = 'chat-messages';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-input';
  input.placeholder = 'Type a message';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'chat-send-btn';
  sendBtn.textContent = 'Send';

  const blockBtn = document.createElement('button');
  blockBtn.className = 'chat-block-btn';
  blockBtn.textContent = 'Block Contact';
  blockBtn.disabled = true;

  const inviteBtn = document.createElement('button');
  inviteBtn.className = 'chat-invite-btn';
  inviteBtn.textContent = 'Invite for Match';
  inviteBtn.disabled = true;

  const controlsDiv = document.createElement('div');
  controlsDiv.className = 'chat-controls';
  controlsDiv.appendChild(blockBtn);
  controlsDiv.appendChild(inviteBtn);
  controlsDiv.appendChild(sendBtn);

  chatArea.appendChild(messagesDiv);
  chatArea.appendChild(input);
  chatArea.appendChild(controlsDiv);

  container.appendChild(playerListContainer); // Add the new container to the main layout
  container.appendChild(chatArea);

  // Used textContent for security (prevents XSS)
  function appendMessage(sender: string, message: string, isOwnMessage = false) {
  const msgDiv = document.createElement('div');
  if (sender === '🤖') {
    msgDiv.className = 'chat-message system-center';
    const strong = document.createElement('strong');
    strong.textContent = sender + ':';
    msgDiv.appendChild(strong);
    msgDiv.append(' ' + message);
  } else {
    msgDiv.className = 'chat-message ' + (isOwnMessage ? 'sent' : 'received');
    const strong = document.createElement('strong');
    strong.textContent = sender + ':';
    msgDiv.appendChild(strong);
    msgDiv.append(' ' + message);
  }
  messagesDiv.appendChild(msgDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

  // --- Show OnlineUser List - Authenticate the user for the chat ---
  // Add retry mechanism for authentication
  const authenticateChat = (retryCount = 0) => {
    const token = sessionStorage.getItem('authToken');
    if (token) {
      socket.emit('authenticate_chat', token);
    } else if (retryCount < 3) {
      // Retry after a short delay if token not found
      setTimeout(() => authenticateChat(retryCount + 1), 200);
    } else {
      appendMessage('🤖', 'Authentication token not found. Chat disabled.');
      console.error('Chat: No auth token found in sessionStorage after retries.');
    }
  };
  
  authenticateChat();

  // Setup handlers
  socket.on('online_users', (users: OnlineUser[]) => {
    console.log('Received online users:', users); // DEBUGGING: Check if users are received
    playerList.innerHTML = '';
    users.forEach((u) => {
        const li = document.createElement('li');
        li.textContent = u.username;
        li.dataset.socketId = u.socketId;
        li.className = 'chat-user-item';
        // List item for each online user
        li.addEventListener('click', async () => { // Make listener async
            // Clear selection styles from other users
            playerList.querySelectorAll('.chat-user-item').forEach(item => item.classList.remove('selected'));
            li.classList.add('selected');

            selectedUser = u;
            messagesDiv.innerHTML = ''; // Clear messages for new user

            // Update block button state
            if (blockedUserIds.has(u.userId)) {
                blockBtn.textContent = 'Unblock Contact';
                blockBtn.classList.add('unblock');
            } else {
                blockBtn.textContent = 'Block Contact';
                blockBtn.classList.remove('unblock');
            }

            // Fetch and display message history
            const token = sessionStorage.getItem('authToken');
            if (token) {
                try {
                    const response = await fetch(`/api/chat/history/${u.userId}`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    if (response.ok) {
                        const history: { sender: string; text: string }[] = await response.json();
                        history.forEach(msg => appendMessage(msg.sender, msg.text));
                    } else {
                        appendMessage('🤖', 'Failed to load message history.');
                    }
                } catch (error) {
                    console.error('Error fetching chat history:', error);
                    appendMessage('🤖', 'Error loading messages.');
                }
            }

            blockBtn.disabled = false;
            inviteBtn.disabled = false;
      });
      playerList.appendChild(li);
    });
  });

  socket.on('lobby_invite_dismissed', ({ message }) => {
    appendMessage('🤖', message);
  });

  socket.on('lobby_invite_accepted', ({ accepterAlias, senderAlias }) => {
    if (accepterAlias) {
      appendMessage('🤖', `${accepterAlias} accepted your match invitation!`);
    } else if (senderAlias) {
      appendMessage('🤖', `You accepted ${senderAlias}'s match invitation!`);
    }
  });

  socket.on('private_message', ({ from, message, username, userId }) => {
    // Ignore message if sender is blocked
    if (blockedUserIds.has(userId)) {
        console.log(`Blocked message from ${username} (${userId})`);
        return;
    }
    if (selectedUser && from === selectedUser.socketId) {
      appendMessage(username, message, false); // false for received messages
    }
  });

  socket.on('user_blocked', ({ targetUserId, message }) => {
    blockedUserIds.add(targetUserId);
    if (selectedUser && selectedUser.userId === targetUserId) {
        blockBtn.textContent = 'Unblock Contact';
        blockBtn.classList.add('unblock');
    }
    appendMessage('🤖', message);
  });

  socket.on('user_unblocked', ({ targetUserId, message }) => {
    blockedUserIds.delete(targetUserId);
    if (selectedUser && selectedUser.userId === targetUserId) {
        blockBtn.textContent = 'Block Contact';
        blockBtn.classList.remove('unblock');
    }
    appendMessage('🤖', message);
  });

  socket.on('blocked_list', (ids: number[]) => {
    blockedUserIds = new Set(ids);
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err.message);
    appendMessage('🤖', 'Error connecting to chat server.');
  });

  function sendMessage() {
    if (selectedUser && input.value.trim()) {
      socket.emit('private_message', { targetSocketId: selectedUser.socketId, message: input.value.trim() });
      appendMessage('Me', input.value, true); // true for sent messages
      input.value = '';
    }
  }

  sendBtn.addEventListener('click', sendMessage);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendMessage();
    }
  });

  inviteBtn.addEventListener('click', () => {
    if (selectedUser) {
      console.log('[DEBUG] Sending tournament invite to:', selectedUser.username, 'Socket ID:', selectedUser.socketId);
      socket.emit('send_public_tournament_invite', { targetSocketId: selectedUser.socketId });
      appendMessage('🤖', `Tournament invite sent to ${selectedUser.username}`);
    } else {
      console.log('[DEBUG] No user selected for invite');
    }
  });

  blockBtn.addEventListener('click', () => {
    if (selectedUser) {
        if (blockedUserIds.has(selectedUser.userId)) {
            // If already blocked, unblock
            socket.emit('unblock_user', { targetUserId: selectedUser.userId });
        } else {
            // If not blocked, block
            socket.emit('block_user', { targetUserId: selectedUser.userId });
        }
    }
  });

  const root = document.querySelector('#dashboard-content');
  root?.appendChild(container);

  return () => {
    container.remove();
  };
}