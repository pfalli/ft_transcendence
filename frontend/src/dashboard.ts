import './dashboard.css';
import { navigateTo } from './main';
import { openAvatarSelectionModal } from './avatarModal';
import { profileEdit } from './profileEdit';
import { io, Socket } from 'socket.io-client';
import { renderChat } from './chat';
import { showUserProfileModal } from './showUserModal';
import { showLobbyInviteCard } from './inviteMatch';

let chatSocket: Socket | null = null;
let onlineUserCache: OnlineUser[] = []; // Cache for online users

// Define a type for online users for better type safety
type OnlineUser = {
  socketId: string;
  userId: number;
  username: string;
  alias: string;
};

export function renderDashboard() {
  document.querySelectorAll('.tournament-dialog').forEach(el => el.remove());

  const appElement = document.querySelector<HTMLDivElement>('#app');
  if (!appElement) {
    throw new Error('App root element (#app) not found!');
  }
  appElement.innerHTML = '';

  const globalContainer = document.createElement('div');
  globalContainer.className = "dashboard-global-container";

  const cardContainer = document.createElement('div');
  cardContainer.className = "dashboard-card-container";

  const sidebar = document.createElement('div');
  sidebar.className = "dashboard-sidebar";

  const sidebarHeading = document.createElement('h2');
  sidebarHeading.className = "dashboard-heading";
  sidebarHeading.textContent = "Dashboard";

  const nav = document.createElement('nav');
  nav.className = "dashboard-nav";

  const profileButton = document.createElement('button');
  profileButton.className = "dashboard-nav-button";
  profileButton.textContent = "Profile";
  profileButton.dataset.view = "profile"; // Custom data attribute to identify view

  const gameButton = document.createElement('button');
  gameButton.className = "dashboard-nav-button";
  gameButton.textContent = "Game";
  gameButton.dataset.view = "game";

  const chatButton = document.createElement('button');
  chatButton.className = "dashboard-nav-button";
  chatButton.textContent = "Chat";
  chatButton.dataset.view = "chat";

  const logoutButton = document.createElement('button');
  logoutButton.className = "dashboard-logout-button";
  logoutButton.textContent = "Logout";

  const contentArea = document.createElement('div');
  contentArea.className = "dashboard-content-area";
  contentArea.id = "dashboard-content"; // ID to easily update content

  nav.appendChild(profileButton);
  nav.appendChild(gameButton);
  nav.appendChild(chatButton);

  sidebar.appendChild(sidebarHeading);
  sidebar.appendChild(nav);
  sidebar.appendChild(logoutButton);

  cardContainer.appendChild(sidebar);
  cardContainer.appendChild(contentArea);

  globalContainer.appendChild(cardContainer);

  appElement.appendChild(globalContainer);

  // --- SOCKET Chat Connection ---
  // Add a small delay to ensure token is available
  setTimeout(() => {
    const token = sessionStorage.getItem('authToken');
    if (token && (!chatSocket || !chatSocket.connected)) {
      if (chatSocket) {
        chatSocket.disconnect(); // Disconnect any old socket
      }
      chatSocket = io(`${import.meta.env.VITE_URL}`, {
        transports: ['websocket'],
        secure: true,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });

      chatSocket.on('connect', () => {
        console.log('%cDEBUG: Session socket connected:', chatSocket?.id);
        // Verify token is still available before authenticating
        const currentToken = sessionStorage.getItem('authToken');
        if (currentToken) {
          chatSocket?.emit('authenticate_chat', currentToken);
        } else {
          console.warn('Token not available during socket connection');
        }
      });

    chatSocket.on('disconnect', () => {
      console.log('%cDEBUG: Session socket disconnected.');
      const list = document.getElementById('online-users-list');
      if (list) {
        list.innerHTML = '<li>Disconnected</li>';
      }
    });

    // Listen for the list of online users and populate the sidebar
    chatSocket.on('online_users', (users: OnlineUser[]) => {
      onlineUserCache = users; // Update the cache
      console.log('Received online users:', users); // Debug log
      const list = document.getElementById('online-users-list');
      if (list) {
        list.innerHTML = ''; // Clear current list
        if (users.length > 0) {
          users.forEach(user => {
            const li = document.createElement('li');
            li.className = 'online-user-item';
            li.dataset.userId = String(user.userId);
            li.textContent = user.username;

            li.addEventListener('click', () => {
              // Use the imported function with a callback to refresh the view
              showUserProfileModal(user.userId, () => {
                setActiveView('profile', navButtons, contentArea);
              });
            });

            list.appendChild(li);
          });
        } else {
          list.innerHTML = '<li>No users online</li>';
        }
      } else {
        console.log('online-users-list element not found'); // Debug log
      }
    });
    // Close popups when clicking elsewhere
    document.addEventListener('click', () => {
        document.querySelectorAll('.user-action-popup').forEach(p => p.remove());
    });
    
    // Add reconnection event handlers
    chatSocket.on('reconnect', (attemptNumber) => {
      console.log(`Chat socket reconnected after ${attemptNumber} attempts`);
    });
    
    chatSocket.on('reconnect_failed', () => {
      console.log('Chat socket failed to reconnect');
    });

    // Set up invite handling inside the socket setup
    chatSocket.on('receive_public_tournament_invite', ({ senderAlias, senderSocketId }) => {
      console.log('[DEBUG] Received tournament invite from:', senderAlias, 'Socket ID:', senderSocketId); // Debug log
      if (chatSocket) {
        console.log('[DEBUG] Showing lobby invite card');
        showLobbyInviteCard(senderAlias, senderSocketId, chatSocket);
      } else {
        console.log('[DEBUG] No chatSocket available to show invite card');
      }
    });
  }
  }, 100); // Close setTimeout - 100ms delay to ensure token is available

   // ----test 2FA QR----
   const twoFaButton = document.createElement('button');
   twoFaButton.className = "dashboard-nav-button";
   twoFaButton.textContent = "2FA Setup";
   twoFaButton.dataset.view = "twofa";
   
   nav.appendChild(twoFaButton); // Add the 2FA button to the navigation

  // Sidebar navigation
  const navButtons = [profileButton, gameButton, chatButton,twoFaButton];
  navButtons.forEach(button => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      if (view) {
        setActiveView(view, navButtons, contentArea);
      }
    });
  });

  // Logout button
  logoutButton.addEventListener('click', () => {
    sessionStorage.removeItem('authToken');
    if (chatSocket) {
      chatSocket.disconnect();
      chatSocket = null;
    }
    navigateTo('/');
  });


  // --- Initial View ---
  setActiveView('profile', navButtons, contentArea); // Set initial view to profile

function showTokenExpired(contentArea: HTMLElement) {
  contentArea.innerHTML = `
    <div class="session-expired-card">
      <div class="session-expired-header">
        <span class="session-expired-icon">
          <img src="/warning.png" alt="Warning" width="42" height="42" />
        </span>
        <span class="session-expired-title">Your session has expired</span>
      </div>
      <div class="session-expired-message">
        Please log in again to continue using the app.
      </div>
      <a href="/" class="session-expired-login-btn">Log in</a>
    </div>
  `;
}

async function fetchWithTokenCheck(
  url: string,
  contentArea: HTMLElement
): Promise<Response | null> {
  const token = sessionStorage.getItem('authToken');
  if (!token) {
    showTokenExpired(contentArea);
    return null;
  }
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    showTokenExpired(contentArea);
    return null;
  }
  return response;
}


async function setActiveView(view: string, buttons: HTMLButtonElement[], contentArea: HTMLDivElement) {
  // Side Buttons of Dashboard bright
  buttons.forEach(btn => {
    if (btn.dataset.view === view) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  const token = sessionStorage.getItem('authToken');

  // Update content area
  contentArea.innerHTML = '';
  switch (view) {
    case 'profile':
      // contentArea.innerHTML = `<h3 class="dashboard-content-heading">Profile</h3><p class="dashboard-content-paragraph">Loading profile...</p>`; // Show loading state
      // Request online users list when switching to profile view
      if (chatSocket && chatSocket.connected) {
        chatSocket.emit('request_online_users');
      }
      try {
        const response = await fetchWithTokenCheck('/api/profile', contentArea);
        if (!response) return;
        const userProfile = await response.json();

        // *** MODIFIED: Fetch all users for the list instead of online users ***
        let allUsersHtml = '<li>Loading players...</li>';
        try {
          const usersResponse = await fetch('/api/users/all', {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (usersResponse.ok) {
            const allUsers = await usersResponse.json();
            const onlineUserIds = new Set(onlineUserCache.map(u => u.userId));
            const remainedUsers = allUsers.filter((user: any) => user.id !== userProfile.userId);

            if (allUsers.length > 0) {
              allUsersHtml = remainedUsers.map((user: any) => {
                const isOnline = onlineUserIds.has(user.id);
                const indicatorHtml = isOnline ? '<span class="online-indicator"></span>' : '';
                return `
                <li class="online-user-item" data-user-id="${user.id}" data-username="${user.username}">
                  ${indicatorHtml}
                  <span>${user.username}</span>
                </li>
              `;
              }).join('');
            } else {
              allUsersHtml = '<li>No players found.</li>';
            }
          } else {
            allUsersHtml = '<li>Could not load player list.</li>';
          }
        } catch (e) {
          console.error('Failed to fetch all users:', e);
          allUsersHtml = '<li>Error loading player list.</li>';
        }

        // ***new: to fetch Match Data***
        let matchHistoryHtml = '<p>Loading match history...</p>';
        try {
          const matchesResponse = await fetch('/api/profile/matches', {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (matchesResponse.ok) {
            const matches = await matchesResponse.json();
            if (matches.length > 0) {
              matchHistoryHtml = `
                <div class="match-history-container">
                  <h4>Match History</h4>
                  <ul>
                    ${matches.map((match: any) => {
                      const matchType = match.is_tournament ? 'Tournament' : 'Single Match';
                      // Format the date for better readability
                      const matchDate = new Date(match.match_date).toLocaleDateString('en-US', {
                        year: 'numeric', month: 'short', day: 'numeric'
                      });
                      return `
                      <li>
                        <div class="match-info">
                          <span class="match-players">${match.player1_username} (${match.player1_score}) vs ${match.player2_username} (${match.player2_score})</span>
                          <span class="match-meta">${matchType} - ${matchDate}</span>
                        </div>
                        <strong class="${match.winner_id === userProfile.userId ? 'win' : 'loss'}">
                          ${match.winner_id === userProfile.userId ? 'Win' : 'Loss'}
                        </strong>
                      </li>
                    `;
                    }).join('')}
                  </ul>
                </div>
              `;
            } else {
              matchHistoryHtml = `
              <div class="match-history-container">
                  <h4>Match History</h4>
                  <p>No match history found.</p>
              </div>`;
            }
          } else {
            matchHistoryHtml = `
              <div class="match-history-container">
                  <h4>Match History</h4>
                  <p>Could not load match history.</p>
              </div>`;
          }
        } catch (e) {
          console.error('Failed to fetch match history:', e);
          matchHistoryHtml = '<p>Error loading match history.</p>';
        }
        // ***end new***

        let friendsListHtml = '<p>Loading friends...</p>';
        try {
          const friendsResponse = await fetch('/api/friends', {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (friendsResponse.ok) {
            const friends = await friendsResponse.json();
            if (friends.length > 0) {
              const onlineUserIds = new Set(onlineUserCache.map(u => u.userId));
              friendsListHtml = `
                <div class="online-users-container-profile">
                  <div class="container-heading">
                    <h4 class="online-users-heading">Friends</h4>
                  </div>
                  <ul class="friends-list">
                    ${friends.map((friend: any) => {
                      const isOnline = onlineUserIds.has(friend.id);
                      const indicatorHtml = isOnline ? '<span class="online-indicator"></span>' : '';
                      return `
                        <li data-user-id="${friend.id}">
                          <img src="${friend.avatar_path || '/avatars/default.png'}" onerror="this.onerror=null;this.src='/avatars/default.png';"/>
                          ${indicatorHtml}
                          <span>${friend.username}</span>
                        </li>
                      `;
                    }).join('')}
                  </ul>
                </div>
              `;
            } else {
              friendsListHtml = `
                <div class="online-users-container-profile">
                  <h4>Friends</h4>
                  <p>No friends yet😢</p>
                </div>`;
            }
          } else {
            friendsListHtml = '<p>Could not load friends list.</p>';
          }
        } catch (e) {
          console.error('Failed to fetch friends:', e);
          friendsListHtml = '<p>Error loading friends list.</p>';
        }

        contentArea.innerHTML = `
          <div class="dashboard-heading-container">
            <h3 class="dashboard-content-heading">${userProfile.username || 'N/A'}</h3>
            <button id="edit-profile-btn" class="edit-profile-button" title="Edit Profile">
              <img src="/settings.svg" alt="Settings" style="width:24px;height:24px;" class="settings-rotate" />
            </button>
          </div>
          <div class="profile-details">
            <div class="profile-avatar-container">
              <img id="profileAvatar" 
                   src="${userProfile.avatar || '/avatars/default.png'}" 
                   alt="User Avatar" 
                   class="profile-avatar-img" 
                   style="cursor: pointer;" 
                   title="Click to change avatar"
				   onerror="this.onerror=null;this.src='/avatars/default.png';">
            </div>
            <p class="dashboard-content-paragraph"><strong>Email:</strong> ${userProfile.email || 'N/A'}</p>
            <p id="avatarUploadStatus" class="dashboard-content-paragraph" style="min-height: 1.2em; margin-top: 0.5rem;"></p>
          </div>
          <div class="profile-lower-container">
            ${friendsListHtml}
            <div class="online-users-container-profile">
              <div class="container-heading">
                <h4 class="online-users-heading">All Players</h4>
                <button id="refresh-players-btn" class="refresh-btn" title="Refresh List">🔄</button>
              </div>
              <ul id="all-players-list" class="online-users-list">
                ${allUsersHtml}
              </ul>
            </div>
            ${matchHistoryHtml}
          </div>
        `;

        // Add click listeners to new friends list
        const friendsList = contentArea.querySelector<HTMLUListElement>('.friends-list');
        if (friendsList) {
          friendsList.querySelectorAll('li').forEach(item => {
            item.addEventListener('click', () => {
              const friendId = parseInt(item.dataset.userId || '0');
              if (friendId) {
                // Update this call as well
                showUserProfileModal(friendId, () => {
                  setActiveView('profile', buttons, contentArea);
                });
              }
            });
          });
        }

        // *** NEW: Attach event listeners to the new 'All Players' list ***
        const allPlayersList = contentArea.querySelector<HTMLUListElement>('#all-players-list');
        if (allPlayersList) {
          allPlayersList.querySelectorAll('.online-user-item').forEach(item => {
            item.addEventListener('click', (e) => {
              const target = e.currentTarget as HTMLLIElement;
              const userId = parseInt(target.dataset.userId || '0');
              if (userId) {
                showUserProfileModal(userId, () => {
                  setActiveView('profile', buttons, contentArea);
                });
              }
            });
          });
        }

        // *** Refresh button ***
        const refreshPlayersBtn = contentArea.querySelector<HTMLButtonElement>('#refresh-players-btn');
        if (refreshPlayersBtn) {
          refreshPlayersBtn.addEventListener('click', () => {
            setActiveView('profile', buttons, contentArea);
          });
        }
        
        const profileAvatarImg = contentArea.querySelector<HTMLImageElement>('#profileAvatar');
        const avatarUploadStatus = contentArea.querySelector<HTMLParagraphElement>('#avatarUploadStatus');
        const editProfileBtn = contentArea.querySelector<HTMLButtonElement>('#edit-profile-btn');

        if (editProfileBtn && token) {
          editProfileBtn.addEventListener('click', () => {
            profileEdit(token, { username: userProfile.username, email: userProfile.email });
          });
        }

        if (profileAvatarImg && avatarUploadStatus && token) {
          profileAvatarImg.addEventListener('click', () => {
            openAvatarSelectionModal(token, profileAvatarImg, avatarUploadStatus);
          });
        }
      } catch (error) {
        console.error('Failed to fetch profile:', error);
        contentArea.innerHTML = `
          <h3 class="dashboard-content-heading">Profile</h3>
          <p class="dashboard-content-paragraph">Could not load profile information. Please try again later.</p>
        `;
      }
      break;
    case 'game':
      const gameTokenCheck = await fetchWithTokenCheck('/api/profile', contentArea);
      if (!gameTokenCheck) return;

      const gameContent = document.createElement('div');
      gameContent.className = "dashboard-game-content";
      gameContent.innerHTML = `<h3 class="dashboard-content-heading">Choose your Game</h3>`;
      
      const gameOptionsContainer = document.createElement('div');
      gameOptionsContainer.className = 'game-options-container';

      const gameOptions = [
        {
          title: 'Local Match',
          image: '/avatars/local.png',
          action: () => navigateTo('/game')
        },
        {
          title: 'Play against AI',
          image: '/avatars/ai.png',
          action: () => navigateTo('/game?mode=ai')
        },
        {
          title: 'Tournament',
          image: '/avatars/tournament.png',
          action: () => navigateTo('/game?tournament=true')
        },
        {
          title: 'Local Tournament',
          image: '/avatars/local2.png',
          action: () => navigateTo('/game?tournament=local')
        }
      ];

      gameOptions.forEach(option => {
        const card = document.createElement('div');
        card.className = 'game-option-card';
        card.innerHTML = `
          <img src="${option.image}" alt="${option.title}">
          <h4>${option.title}</h4>
        `;
        card.addEventListener('click', option.action);
        gameOptionsContainer.appendChild(card);
      });

      gameContent.appendChild(gameOptionsContainer);
      contentArea.appendChild(gameContent);
      break;
    case 'chat':
      // Try to get username for display
      let username = 'User';
      const response = await fetchWithTokenCheck('/api/profile', contentArea);
      if (!response) return;
      
      if (token) {
          const response = await fetch('/api/profile', {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            }
          });
          if (response.ok) {
            const userProfile = await response.json();
            username = userProfile.username || 'User';
          }
        }
        
      contentArea.innerHTML = `
          <h3 class="dashboard-content-heading">${username}'s Messages</h3>
        `;
      if (chatSocket && chatSocket.connected) {
        renderChat(chatSocket);
      } else {
        contentArea.innerHTML = `
          <h3 class="dashboard-content-heading">ChatSocket for LiveChat not connected</h3>
        `;
      }
      break;
      // -----------2FA case----------
      case 'twofa':
        contentArea.innerHTML = `
		    <h3 class="dashboard-content-heading">Two-Factor Authentication Setup</h3>
		    <button id="generate-qr-btn" class="dashboard-action-button" style="margin-top: 20px;">Generate QR Code</button>
		    <p id="qr-instructions" style="margin-top: 8px;">⚠️ If you click here, your profile will be set with 2FA</p>
		    <div id="qr-code-container" style="margin-top: 20px;">
		      <p id="qr-success" style="display: none; color: white;">✅ Done, your Profile has 2FA enabled. Scan the QR code</p>
		      <img id="qr-code" style="display: none; max-width: 200px; display: block; margin: 0 auto;" />
		    </div>
		    <p id="qr-error" style="color: red;"></p>
		  `;
      
        const generateQrButton = contentArea.querySelector<HTMLButtonElement>('#generate-qr-btn');
        const qrCodeImage = contentArea.querySelector<HTMLImageElement>('#qr-code');
        const qrInstructions = contentArea.querySelector<HTMLParagraphElement>('#qr-instructions');
        const qrError = contentArea.querySelector<HTMLParagraphElement>('#qr-error');
        const qrSuccess = contentArea.querySelector<HTMLParagraphElement>('#qr-success');

        if (generateQrButton && qrCodeImage && qrInstructions && qrError && qrSuccess) {
          generateQrButton.addEventListener('click', async () => {
            qrError.textContent = ''; // Clear any previous errors
            qrCodeImage.style.display = 'none';
            qrInstructions.style.display = 'none';
			qrSuccess.style.display = 'none';

      
            try {
              const token = sessionStorage.getItem('authToken'); // Replace with your token storage logic
              if (!token) {
                throw new Error('User is not authenticated. Please log in.');
              }
      
              const response = await fetch('/api/2fa/setup', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`
                },
              });
      
              if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to generate QR code.');
              }
      
              const data = await response.json();
              qrCodeImage.src = data.qrCode; // Set the QR code image source
              qrCodeImage.style.display = 'block';
              qrSuccess.style.display = 'block';
            } catch (error) {
              qrError.textContent = (error as Error).message;
              console.error(error);
            }
          });
        }
        break;
  }
}
}