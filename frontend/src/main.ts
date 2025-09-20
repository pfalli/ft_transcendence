
import './style.css';
import { renderWelcome } from './welcome';
import { renderLogin } from './login';
import { renderSignUp } from './signup';
import { renderDashboard } from './dashboard';
import { renderGame } from './game';
// import { renderDelete } from './delete';
import { renderGoogle } from './google';
import { renderTwoFA } from './twofa';
import { isAuthenticated, hasTempToken, PROTECTED_ROUTES, PUBLIC_ONLY_ROUTES } from './auth';


// --- DOM ---
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App root element (#app) not found!');
}

// --- Navigation Helper ---
export function navigateTo(path: string) {
  history.pushState({}, '', path);
  router();
}

// --- Handler for Google Auth Token ---
function handleGoogleAuthToken(): (() => void) | void {
  const queryParams = new URLSearchParams(window.location.search); // Use query parameters
  const token = queryParams.get('token');
  const error = queryParams.get('error');

  // Clean the URL by removing query parameters after processing
  if (token || error) {
    history.replaceState({}, '', window.location.pathname);
  }

  if (token) {
    sessionStorage.setItem('authToken', token);
    console.log('Google Auth Token stored successfully.');
    // Add small delay to ensure token is properly stored before navigation
    setTimeout(() => navigateTo('/dashboard'), 50);
  } else if (error) {
    console.error('Google authentication failed:', error);
    alert(`Google authentication failed: ${error}. Please try again.`);
    navigateTo('/login');
  } else {
    // This might be hit if /google-auth-handler is accessed directly without params
    console.warn('Google auth handler called without token or error. Redirecting to login.');
    navigateTo('/login');
  }
}

// --- Welcome Page ---


// --- Router ---
const routes: { [key: string]: () => (() => void) | void } = { // render functions can return a cleanup function
  '/': renderWelcome,
  '/login': renderLogin,
  '/signUp': renderSignUp,
  '/google-auth-handler': handleGoogleAuthToken,
  '/game': renderGame,
  '/dashboard': renderDashboard,
//   '/delete': renderDelete, // Add the delete route
  '/username-google': renderGoogle,
  '/2fa': renderTwoFA,


};

let currentCleanupFunction: (() => void) | null = null;

function router() {
  // Execute cleanup function of the previous view
  if (currentCleanupFunction) {
    currentCleanupFunction();
    currentCleanupFunction = null;
  }

  // Get the path from the pathname
  const path = window.location.pathname || '/';
  console.log("Navigating to:", path); // For debugging

  // Authentication checks
  const userIsAuthenticated = isAuthenticated();
  const userHasTempToken = hasTempToken();

  // Check if this is a protected route
  if (PROTECTED_ROUTES.includes(path)) {
    if (!userIsAuthenticated) {
      console.log("Access denied: Authentication required for", path);
      // Redirect to login for protected routes
      history.replaceState({}, '', '/login');
      const cleanup = renderLogin();
      if (typeof cleanup === 'function') {
        currentCleanupFunction = cleanup;
      }
      return;
    }
  }

  // Check if user is trying to access public-only routes while authenticated
  if (PUBLIC_ONLY_ROUTES.includes(path) && userIsAuthenticated) {
    console.log("Redirecting authenticated user from", path, "to dashboard");
    // Redirect authenticated users away from login/signup pages
    history.replaceState({}, '', '/dashboard');
    const cleanup = renderDashboard();
    if (typeof cleanup === 'function') {
      currentCleanupFunction = cleanup;
    }
    return;
  }

  // Special case for 2FA route
  if (path === '/2fa') {
    if (!userHasTempToken && !userIsAuthenticated) {
      console.log("Access denied: No temp token for 2FA");
      history.replaceState({}, '', '/login');
      const cleanup = renderLogin();
      if (typeof cleanup === 'function') {
        currentCleanupFunction = cleanup;
      }
      return;
    }
  }

  // Find the matching route or default to Welcome
  const renderFunction = routes[path] || routes['/'] || renderWelcome; // Ensure fallback

  // Render the corresponding page and store its cleanup function
  const cleanup = renderFunction();
  if (typeof cleanup === 'function') {
    currentCleanupFunction = cleanup;
  }
}

// --- Event Listeners ---
// Listen for popstate events (browser back/forward)
window.addEventListener('popstate', router);

// Listen for initial page load
window.addEventListener('load', () => {
    // Intercept clicks on all internal links
    document.body.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const anchor = target.closest('a[href^="/"]');
        if (anchor && anchor.getAttribute('href') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            const path = anchor.getAttribute('href');
            if (path) {
                navigateTo(path);
            }
        }
    });
    router(); // Render the initial page
});

// Ensure router runs if page was already loaded (e.g. script loaded async)
if (document.readyState === 'complete') {
    router();
}