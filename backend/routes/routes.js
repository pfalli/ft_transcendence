import { fileURLToPath } from 'url';
import path from 'path';
import DB from '../data_controller/dbConfig.js';
import hashPassword, { comparePassword } from '../crypto/crypto.js';
import { exchangeCodeForToken, fetchUserInfo } from '../token_google/exchangeToken.js';
import jwt from 'jsonwebtoken';
import { promises as fs } from 'node:fs'; // For async file operations
import crypto from 'node:crypto'; // For generating unique filenames
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getJWTSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error ('JWT_SECRET environment variable is not set');
  }
  return secret;
}

const developerRoutes = (app) => {
  //2FA --test
  app.post('/api/2fa/setup', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.substring(7);
    let decodedToken;
    try {
      decodedToken = jwt.verify(token, getJWTSecret());
    } catch (err) {
      return reply.status(401).send({ error: 'Unauthorized: Invalid token' });
    }

    const userId = decodedToken.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized: Invalid token payload' });
    }

    // Generate a 2FA secret
    const secret = speakeasy.generateSecret({ name: 'YourAppName' });

    // Save the secret to the database
    await DB('credentialsTable').where({ id: userId }).update({ two_factor_secret: secret.base32 });
	await DB('credentialsTable').where({ id: userId }).update({ two_factor_enabled: true });

    // Generate a QR code for the user to scan
    const qrCodeDataURL = await QRCode.toDataURL(secret.otpauth_url);

	// *** DEBUG***
      const updatedUser = await DB('credentialsTable').where({ id: userId }).first();
      console.log(`--- 2FA Status SETUP Update for User ID: ${userId} ---`);
      console.log(`User '${updatedUser.username}' has successfully enabled 2FA: ${updatedUser.two_factor_enabled}`);
      console.log('-----------------------------------------');

    reply.send({ success: true, qrCode: qrCodeDataURL });
  });

  // -------------verify-------------

  app.post('/api/2fa/verify', async (req, reply) => {
    const { token } = req.body;
    const authHeader = req.headers.authorization;
  
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized: No token provided' });
    }
  
    const jwtToken = authHeader.substring(7);
    let decodedToken;
    try {
      decodedToken = jwt.verify(jwtToken, getJWTSecret());
    } catch (err) {
      return reply.status(401).send({ error: 'Unauthorized: Invalid token' });
    }
  
    const userId = decodedToken.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized: Invalid token payload' });
    }
  
    const user = await DB('credentialsTable').where({ id: userId }).first();
    if (!user || !user.two_factor_secret) {
	  console.log('2FA verification failed: User not found or 2FA not set up.');
      return reply.status(400).send({ error: '2FA is not set up for this user' });
    }
  
    const verified = speakeasy.totp.verify({
      secret: user.two_factor_secret,
      encoding: 'base32',
      token,
    });
  
    if (!verified) {
      return reply.status(400).send({ error: 'Invalid 2FA token' });
    }

	// *** DEBUG***
      const updatedUser = await DB('credentialsTable').where({ id: userId }).first();
      console.log(`--- 2FA Status VERIFY Update for User ID: ${userId} ---`);
      console.log(`User '${updatedUser.username}' has successfully enabled 2FA: ${updatedUser.two_factor_enabled}`);
      console.log('-----------------------------------------');
  
    reply.send({ success: true, message: '2FA verified successfully' });
  });

	// Developer routes removed for security reasons
	// If admin functionality is needed, implement proper authentication and authorization
}

const credentialsRoutes = (app) =>{
  app.get('/api/profile', async (req, reply) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Unauthorized: No token provided' });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer '

    try {
      const decodedToken = jwt.verify(token, getJWTSecret());
      const userId = decodedToken.userId;

      if (!userId) {
        reply.status(401).send({ error: 'Unauthorized: Invalid token payload' });
        return;
      }

      const user = await DB('credentialsTable').where({ id: userId }).first();

      if (!user) {
        reply.status(404).send({ error: 'User not found' });
        return;
      }

      // JSON sending to frontend
      const userProfile = {
        userId: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar_path || null // Send avatar path
      };

      reply.send(userProfile); // Send profile data as JSON

    } catch (err) {
      if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        reply.status(401).send({ error: `Unauthorized: ${err.message}` });
      } else {
        console.error('Error fetching profile:', err);
        reply.status(500).send({ error: 'Server error while fetching profile' });
      }
    }
  });

  // *** new: to get Match Data***
  app.get('/api/profile/matches', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.substring(7);
    try {
      const decodedToken = jwt.verify(token, getJWTSecret());
      const userId = decodedToken.userId;

      const matches = await DB('matchHistory')
        .where('player1_id', userId)
        .orWhere('player2_id', userId)
        .orderBy('match_date', 'desc')
        .limit(20);
      
      reply.send(matches);
    } catch (err) {
      console.error('Error fetching match history:', err);
      reply.status(500).send({ error: 'Server error while fetching match history' });
    }
  });


  // --- UPDATE PROFILE ---
  app.patch('/api/profile', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.substring(7);

    try {
      const decodedToken = jwt.verify(token, getJWTSecret());
      const userId = decodedToken.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized: Invalid token payload' });
      }

      const { username, email, newPassword, currentPassword } = req.body;
      const updates = {};

      // Fetch the current user from the DB
      const user = await DB('credentialsTable').where({ id: userId }).first();
      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      // Check if the user authenticated via Google
      const isGoogleUser = user.auth_provider === 'google';

      if (isGoogleUser) {
        // Google users can only change their username.
        if (username && username !== user.username) {
          const existingUser = await DB('credentialsTable').where({ username }).first();
          if (existingUser && existingUser.id !== userId) {
            return reply.status(409).send({ error: 'Username is already taken.' });
          }
          updates.username = username;
        }
      } else {
        // Check for username update
        if (username && username !== user.username) {
          const existingUser = await DB('credentialsTable').where({ username }).first();
          if (existingUser && existingUser.id !== userId) {
            return reply.status(409).send({ error: 'Username is already taken.' });
          }
          updates.username = username;
        }

        // Check for email update
        if (email && email !== user.email) {
          const existingUser = await DB('credentialsTable').where({ email }).first();
          if (existingUser && existingUser.id !== userId) {
            return reply.status(409).send({ error: 'Email is already in use.' });
          }
          updates.email = email;
        }

        // Check for password update
        if (newPassword) {
          if (newPassword.length < 8) {
            return reply.status(400).send({ error: 'New password must be at least 8 characters long.' });
          }
          updates.password = await hashPassword(newPassword);
        }
      }

      // If there are updates, apply them to the database
      if (Object.keys(updates).length > 0) {
        await DB('credentialsTable').where({ id: userId }).update(updates);
        return reply.send({ success: true, message: 'Profile updated successfully.' });
      }

      return reply.send({ success: true, message: 'No changes detected.' });

    } catch (err) {
      if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        return reply.status(401).send({ error: `Unauthorized: ${err.message}` });
      }
      console.error('Error updating profile:', err);
      reply.status(500).send({ error: 'Server error while updating profile.' });
    }
  });


  app.post('/api/profile/avatar', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.substring(7);
    let decodedToken;
    try {
      decodedToken = jwt.verify(token, getJWTSecret());
    } catch (err) {
      return reply.status(401).send({ error: 'Unauthorized: Invalid token' });
    }
    const userId = decodedToken.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized: Invalid token payload' });
    }

    const data = await req.file();

    if (!data || !data.file) {
      return reply.status(400).send({ error: 'No file uploaded or invalid format.' });
    }

    if (!['image/jpeg', 'image/png', 'image/gif'].includes(data.mimetype)) {
      return reply.status(400).send({ error: 'Invalid file type. Only JPG, PNG, GIF allowed.' });
    }

    try {
      const buffer = await data.toBuffer();
      const fileExtension = path.extname(data.filename) || `.${data.mimetype.split('/')[1]}`;
      const uniqueFilename = `${userId}_${crypto.randomBytes(8).toString('hex')}${fileExtension}`;
      const avatarFilePath = path.join(__dirname, '..', '..', 'uploads', 'avatars', uniqueFilename); // Adjusted path
      const avatarUrlPath = `/uploads/avatars/${uniqueFilename}`; // Path to be stored in DB and used by frontend

      await fs.writeFile(avatarFilePath, buffer);

      await DB('credentialsTable')
        .where({ id: userId })
        .update({ avatar_path: avatarUrlPath }); // Store the URL path

      console.log('Avatar path updated in DB for userId:', userId, 'to', avatarUrlPath);

      reply.send({ success: true, message: 'Avatar uploaded successfully.', avatarPath: avatarUrlPath }); // Send the path back
    } catch (error) {
      console.error('Error uploading avatar:', error);
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(413).send({ error: 'File too large. Maximum size is 5MB.' });
      }
      reply.status(500).send({ error: 'Failed to upload avatar.' });
    }
  });

  app.get('/api/profile/public/:id', async (req, reply) => {
    const { id } = req.params;
    try {
      const user = await DB('credentialsTable').where({ id }).first();
      if (!user) return reply.status(404).send({ error: 'User not found' });

      // Fetch match history for the user
      const matches = await DB('matchHistory')
        .where('player1_id', id)
        .orWhere('player2_id', id)
        .orderBy('match_date', 'desc')
        .limit(20);

      reply.send({ 
        userId: user.id, 
        username: user.username, 
        avatar: user.avatar_path || null,
        matches: matches
      });
    } catch (err) {
      console.error('Error fetching public profile:', err);
      reply.status(500).send({ error: 'Server error while fetching profile' });
    }
  });

  app.post('/signUp', async (req, reply) => {
    const { username, email, password: rawPassword } = req.body;
    if (!username || !email || !rawPassword) {
      reply.status(400).send({ error: 'All fields (username, email, password) are required' });
      return;
    }

    if (rawPassword.length < 8) {
      reply.status(400).send({ error: 'Password must be at least 8 characters long' });
      return;
    }

    try {
      //check if already exists
      const exists = await DB('credentialsTable')
        .where({ username })
        .orWhere({ email })
        .first();
      if (exists) {
        reply.status(400).send({ error: 'Username or email already in use' });
        return;
      }

      const password = await hashPassword(rawPassword);
      const [id] = await DB('credentialsTable').insert({ username, email, password });
      reply.status(201).send({ success: true, id: id });
    } catch (e) {
      console.error(e);
      reply.status(500).send({ error: 'Signup failed due to server error' });
    }
  });

  app.post('/login', async (req, reply) => {
    const { email, password: rawPassword } = req.body;
    if (!email || !rawPassword) {
      reply.status(401).send({ error: 'Email and password are required' });
      return;
    }
   
    try {
      const user = await DB('credentialsTable').where({ email }).first();
      if (!user || !(await comparePassword(rawPassword, user.password))) {
        reply.status(401).send({ error: 'Invalid email or password' });
        return;
      }

      // Migrate legacy SHA-256 password to bcrypt on successful login
      if (!user.password.startsWith('$2b$')) {
        console.log(`Migrating password for user ${user.username} from SHA-256 to bcrypt`);
        const newBcryptPassword = await hashPassword(rawPassword);
        await DB('credentialsTable').where({ id: user.id }).update({ password: newBcryptPassword });
        console.log(`Password migration completed for user ${user.username}`);
      }

	  // *** DEBUG ****
      console.log('--- User Login Data ---');
      console.log(user);
      console.log('-----------------------');
      if (user.two_factor_enabled) { // Check if 2FA is fully enabled
        // Step 1 complete: return short-lived temp token
        const tempToken = jwt.sign(
          { userId: user.id, twoFAPending: true },
          getJWTSecret(),
          { expiresIn: '5m' } // short lifespan
        );
      
        return reply.send({
          success: true,
          requires2FA: true,
          tempToken
        });
      }
      // Generate token
      const tokenPayload = {
        userId: user.id,
        email: user.email,
        username: user.username
      };
      // Sign the token - expires in 1 hour
      const token = jwt.sign(tokenPayload, getJWTSecret(), { expiresIn: '1h' });
      
      reply.send({
        success: true,
        message: 'Login successful',
        userId: user.id,
        username: user.username,
        token: token // Send token to frontend
      });    
    } catch (e) {
      console.error(e);
      reply.status(500).send({ error: 'Login failed due to server error' });
    }
  });

  // --- FRIENDS API ---

  // Get list of friends (accepted)
  app.get('/api/friends', async (req, reply) => {
    const token = req.headers.authorization?.substring(7);
    if (!token) return reply.status(401).send({ error: 'Unauthorized' });

    try {
      const decoded = jwt.verify(token, getJWTSecret());
      const userId = decoded.userId;

      const friends = await DB('friendships')
        .where({ status: 'accepted' })
        .andWhere(function() {
          this.where('user1_id', userId).orWhere('user2_id', userId)
        })
        .then(rows => {
          const friendIds = rows.map(row => row.user1_id === userId ? row.user2_id : row.user1_id);
          return DB('credentialsTable').whereIn('id', friendIds).select('id', 'username', 'avatar_path');
        });
      
      reply.send(friends);
    } catch (err) {
      console.error('Error fetching friends:', err);
      reply.status(500).send({ error: 'Server error' });
    }
  });

  // Send a friend request
  app.post('/api/friends/add', async (req, reply) => {
    const token = req.headers.authorization?.substring(7);
    const { friendId } = req.body;
    if (!token) return reply.status(401).send({ error: 'Unauthorized' });

    try {
      const decoded = jwt.verify(token, getJWTSecret());
      const userId = decoded.userId;

      if (userId === friendId) {
        return reply.status(400).send({ error: 'You cannot add yourself as a friend.' });
      }

      // Ensure user IDs are ordered to prevent duplicate rows (user1 < user2)
      const user1_id = Math.min(userId, friendId);
      const user2_id = Math.max(userId, friendId);

      const existing = await DB('friendships').where({ user1_id, user2_id }).first();
      if (existing) {
        return reply.status(409).send({ error: 'You are already friends.' });
      }

      await DB('friendships').insert({
        user1_id,
        user2_id,
        status: 'accepted',
        action_user_id: userId
      });

      reply.send({ success: true, message: 'Friend added successfully.' });
    } catch (err) {
      console.error('Error adding friend:', err);
      reply.status(500).send({ error: 'Server error' });
    }
  });

  // Delete a friend
  app.post('/api/friends/delete', async (req, reply) => {
    const token = req.headers.authorization?.substring(7);
    const { friendId } = req.body;
    if (!token) return reply.status(401).send({ error: 'Unauthorized' });

    try {
      const decoded = jwt.verify(token, getJWTSecret());
      const userId = decoded.userId;

      // Order IDs to match how they are stored in the database
      const user1_id = Math.min(userId, friendId);
      const user2_id = Math.max(userId, friendId);

      const deletedCount = await DB('friendships').where({ user1_id, user2_id }).del();

      if (deletedCount > 0) {
        reply.send({ success: true, message: 'Friend removed successfully.' });
      } else {
        reply.status(404).send({ error: 'Friendship not found.' });
      }
    } catch (err) {
      console.error('Error deleting friend:', err);
      reply.status(500).send({ error: 'Server error' });
    }
  });


  // Get friendship status with a specific user
  app.get('/api/friends/status/:otherUserId', async (req, reply) => {
    const token = req.headers.authorization?.substring(7);
    const { otherUserId } = req.params;
    if (!token) return reply.status(401).send({ error: 'Unauthorized' });

    try {
      const decoded = jwt.verify(token, getJWTSecret());
      const userId = decoded.userId;

      const user1_id = Math.min(userId, parseInt(otherUserId));
      const user2_id = Math.max(userId, parseInt(otherUserId));

      const friendship = await DB('friendships').where({ user1_id, user2_id }).first();

      if (!friendship) {
        return reply.send({ status: 'none' });
      }
      
      reply.send({ 
        status: friendship.status,
        action_user_id: friendship.action_user_id
      });

    } catch (err) {
      console.error('Error fetching friendship status:', err);
      reply.status(500).send({ error: 'Server error' });
    }
  });

  app.get('/api/users/all', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Unauthorized: No token provided' });
      return;
    }
    const token = authHeader.split(' ')[1];

    try {
      // Verify the token to ensure the request is authenticated
      jwt.verify(token, getJWTSecret());

      // Fetch all users from the database
      const allUsers = await DB('credentialsTable').select('id', 'username').orderBy('username', 'asc');
      
      reply.send(allUsers);

    } catch (err) {
      if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        reply.status(401).send({ error: `Unauthorized: ${err.message}` });
      } else {
        console.error('Error fetching all users:', err);
        reply.status(500).send({ error: 'Server error while fetching users' });
      }
    }
  });

  // *** NEW: Endpoint to get chat history with another user ***
  app.get('/api/chat/history/:otherUserId', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.substring(7);
    try {
      const decodedToken = jwt.verify(token, getJWTSecret());
      const userId = decodedToken.userId;
      const otherUserId = parseInt(req.params.otherUserId, 10);

      if (isNaN(otherUserId)) {
        return reply.status(400).send({ error: 'Invalid user ID format.' });
      }

      const messages = await DB('chat_messages')
        .where(function() {
          this.where('sender_id', userId).andWhere('recipient_id', otherUserId)
        })
        .orWhere(function() {
          this.where('sender_id', otherUserId).andWhere('recipient_id', userId)
        })
        .orderBy('created_at', 'asc')
        .join('credentialsTable as sender', 'chat_messages.sender_id', 'sender.id')
        .select(
          'chat_messages.message_text as text',
          'sender.username as sender',
          'chat_messages.created_at'
        );

      reply.send(messages);

    } catch (err) {
      console.error('Error fetching chat history:', err);
      reply.status(500).send({ error: 'Server error while fetching chat history' });
    }
  });

  app.post('/login/2fa', async (req, reply) => {
    const { token: twoFAToken, tempToken } = req.body;
  
    if (!tempToken) {
      return reply.status(400).send({ error: 'Temporary token is required' });
    }
  
    let decoded;
    try {
      decoded = jwt.verify(tempToken, getJWTSecret());
    } catch (err) {
      return reply.status(401).send({ error: 'Invalid or expired temporary token' });
    }
  
    if (!decoded.twoFAPending) {
      return reply.status(400).send({ error: 'Not a valid 2FA pending session' });
    }
  
    const user = await DB('credentialsTable').where({ id: decoded.userId }).first();
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
  
    const verified = speakeasy.totp.verify({
      secret: user.two_factor_secret,
      encoding: 'base32',
      token: twoFAToken,
      window: 1

    });
  
    if (!verified) {
      return reply.status(400).send({ error: 'Invalid 2FA code' });
    }
  
    // 2FA passed → issue real token
    const realToken = jwt.sign(
      { userId: user.id, email: user.email, username: user.username },
      getJWTSecret(),
      { expiresIn: '24h' }
    );
  
    reply.send({ success: true, token: realToken });
  });


  app.get('/username-google', async (req, reply) => {
    const { code } = req.query;
    if (!code) {
      return reply.redirect('/login?error=google_auth_missing_code');
    }
  
    try {
      const tokenResponse = await exchangeCodeForToken(code);
      if (!tokenResponse || !tokenResponse.access_token) {
        console.error('Failed to exchange code for token or access_token missing:', tokenResponse);
        return reply.redirect('/login?error=google_token_exchange_failed');
      }
      const userInfo = await fetchUserInfo(tokenResponse.access_token);
      if (!userInfo || !userInfo.email) {
        console.error('Failed to fetch user info from Google or email missing:', userInfo);
        return reply.redirect('/login?error=google_user_info_failed');
      }
  
      const { email, name } = userInfo;
      let user = await DB('credentialsTable').where({ email }).first();
  
      if (!user) {
        const username = name || `user_${Date.now()}`;
        const placeholderPassword = await hashPassword(`google_auth_${email}_${Date.now()}`);
        const [id] = await DB('credentialsTable').insert({
          email,
          username,
          password: placeholderPassword,
          auth_provider: 'google' // Make sure to set the provider
        });
        user = { id, email, username, two_factor_enabled: false }; // Ensure user object is complete
      }
  
      // Check if the user has 2FA enabled
      if (user.two_factor_enabled) {
        // Generate a temporary token for 2FA verification
        const tempToken = jwt.sign(
          { userId: user.id, twoFAPending: true },
          getJWTSecret(),
          { expiresIn: '5m' } // Short lifespan
        );
  
        return tempToken, reply.redirect(`/2fa?tempToken=${tempToken}`);
      }
  
      // Generate JWT token for the user
      const tokenPayload = {
        userId: user.id,
        email: user.email,
        username: user.username,
      };
      const jwtAuthToken = jwt.sign(tokenPayload, getJWTSecret(), { expiresIn: '1h' });
  
      reply.redirect(`/google-auth-handler?token=${jwtAuthToken}`);
    } catch (e) {
      console.error('Error during Google OAuth callback:', e);
      reply.redirect('/login?error=google_auth_failed');
    }
  });
}

export {developerRoutes, credentialsRoutes};
