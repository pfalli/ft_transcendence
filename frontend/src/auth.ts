// Authentication utility functions

/**
 * Check if user is authenticated by verifying the presence of a valid token
 */
export function isAuthenticated(): boolean {
  const token = sessionStorage.getItem('authToken');
  if (!token) {
    return false;
  }
  
  // Basic JWT token validation (check if it's not expired)
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Check if token is expired
    if (payload.exp && payload.exp < currentTime) {
      // Token is expired, remove it
      sessionStorage.removeItem('authToken');
      return false;
    }
    
    return true;
  } catch (error) {
    // Invalid token format, remove it
    console.warn('Invalid token format, removing token');
    sessionStorage.removeItem('authToken');
    return false;
  }
}

/**
 * Check if user has a temporary token (for 2FA flow)
 */
export function hasTempToken(): boolean {
  return !!sessionStorage.getItem('tempToken');
}

/**
 * Get the current user info from the token
 */
export function getCurrentUser(): { userId: number; username: string; email: string } | null {
  const token = sessionStorage.getItem('authToken');
  if (!token) {
    return null;
  }
  
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return {
      userId: payload.userId,
      username: payload.username,
      email: payload.email
    };
  } catch (error) {
    console.warn('Error parsing token payload');
    return null;
  }
}

/**
 * Clear all authentication data and redirect to welcome page
 */
export function logout(): void {
  clearAuth();
  // Import navigateTo dynamically to avoid circular dependency
  import('./main').then(({ navigateTo }) => {
    navigateTo('/');
  });
}

/**
 * Clear all authentication data
 */
export function clearAuth(): void {
  sessionStorage.removeItem('authToken');
  sessionStorage.removeItem('tempToken');
}

/**
 * Routes that require authentication
 */
export const PROTECTED_ROUTES = [
  '/dashboard',
  '/game',
  '/profile',
  '/chat'
];

/**
 * Routes that should redirect to dashboard if user is already authenticated
 */
export const PUBLIC_ONLY_ROUTES = [
  '/login',
  '/signUp'
];