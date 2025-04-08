const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true })); // Support form data

// Store active sharing sessions
const activeSessions = new Map();

// Basic search index for faster lookups
const searchIndex = {
  byPostId: new Map(),    // Maps post IDs to session IDs
  byUrl: new Map()        // Maps URLs to session IDs
};

// Utility function for logging
const logger = {
  info: (message) => console.log(`[INFO] ${new Date().toISOString()}: ${message}`),
  error: (message) => console.error(`[ERROR] ${new Date().toISOString()}: ${message}`),
  success: (message) => console.log(`[SUCCESS] ${new Date().toISOString()}: ${message}`)
};

/**
 * Get all active sharing sessions with optional search functionality
 */
app.get('/sessions', (req, res) => {
  try {
    const { search } = req.query;
    
    let data = Array.from(activeSessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      url: session.url,
      postId: session.postId,
      count: session.count,
      target: session.target,
      progress: Math.round((session.count / session.target) * 100),
      status: session.status,
      startTime: session.startTime,
      estimatedEndTime: session.estimatedEndTime
    }));
    
    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      data = data.filter(session => 
        session.url.toLowerCase().includes(searchLower) || 
        session.postId.toString().includes(searchLower) ||
        session.sessionId.toLowerCase().includes(searchLower)
      );
      
      logger.info(`Search performed with term: "${search}", found ${data.length} results`);
    }
    
    res.json(data);
  } catch (error) {
    logger.error(`Error fetching sessions: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

/**
 * Serve main page
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Start a new sharing session
 */
app.post('/api/share', async (req, res) => {
  const { cookie, url, amount, interval } = req.body;
  
  // Validate required fields
  if (!cookie) return res.status(400).json({ error: 'Facebook cookie is required' });
  if (!url) return res.status(400).json({ error: 'Facebook post URL is required' });
  if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount is required' });
  if (!interval || isNaN(interval) || interval < 1) return res.status(400).json({ error: 'Interval must be at least 1 second' });

  try {
    // Process and convert cookie format
    const cookies = await convertCookie(cookie);
    if (!cookies) {
      return res.status(400).json({ error: 'Invalid Facebook cookies format' });
    }
    
    // Start sharing session
    const sessionId = await startSharingSession(cookies, url, parseInt(amount), parseInt(interval));
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Failed to start sharing session' });
    }
    
    res.status(200).json({
      status: 'success',
      message: 'Sharing session started successfully',
      sessionId
    });
  } catch (err) {
    logger.error(`Share request failed: ${err.message}`);
    return res.status(500).json({
      status: 'error',
      error: err.message || 'An unexpected error occurred'
    });
  }
});

/**
 * Stop an active sharing session
 */
/**
 * Stop an active sharing session
 */
app.post('/api/stop', (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }
  
  if (!activeSessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    const session = activeSessions.get(sessionId);
    clearInterval(session.timer);
    session.status = 'stopped';
    activeSessions.set(sessionId, session);
    
    logger.info(`Session ${sessionId} stopped manually`);
    
    return res.status(200).json({
      status: 'success',
      message: 'Session stopped successfully'
    });
  } catch (error) {
    logger.error(`Error stopping session: ${error.message}`);
    return res.status(500).json({
      status: 'error',
      error: 'Failed to stop session'
    });
  }
});

/**
 * Find sessions by post ID
 */
app.get('/api/find-by-post/:postId', (req, res) => {
  try {
    const { postId } = req.params;
    
    if (!postId) {
      return res.status(400).json({ error: 'Post ID is required' });
    }
    
    // Get sessions directly from the index
    const sessionIds = searchIndex.byPostId.has(postId) 
      ? Array.from(searchIndex.byPostId.get(postId))
      : [];
    
    // Get full session data
    const sessions = sessionIds
      .filter(id => activeSessions.has(id))
      .map(id => {
        const session = activeSessions.get(id);
        return {
          sessionId: id,
          url: session.url,
          postId: session.postId,
          count: session.count,
          target: session.target,
          progress: Math.round((session.count / session.target) * 100),
          status: session.status,
          startTime: session.startTime,
          estimatedEndTime: session.estimatedEndTime
        };
      });
    
    logger.info(`Found ${sessions.length} sessions for post ID: ${postId}`);
    
    return res.status(200).json({
      postId,
      count: sessions.length,
      sessions
    });
  } catch (error) {
    logger.error(`Error finding sessions by post ID: ${error.message}`);
    return res.status(500).json({ error: 'Failed to find sessions' });
  }
});

/**
 * Start a Facebook post sharing session
 * @param {string} cookies - Facebook cookies
 * @param {string} url - Facebook post URL
 * @param {number} amount - Number of shares to perform
 * @param {number} interval - Interval between shares in seconds
 * @returns {string} - Session ID
 */
async function startSharingSession(cookies, url, amount, interval) {
  // Extract post ID from URL
  const postId = await getPostID(url);
  
  if (!postId) {
    throw new Error("Unable to get post ID: invalid URL or the post might be private/friends-only");
  }
  
  // Get Facebook access token
  const accessToken = await getAccessToken(cookies);
  
  if (!accessToken) {
    throw new Error("Failed to obtain Facebook access token. Please check your cookies.");
  }
  
  // Generate unique session ID
  const sessionId = `${postId}_${Date.now()}`;
  
  // Calculate estimated end time
  const estimatedEndTime = new Date(Date.now() + (amount * interval * 1000));
  
  // Create session object
  const sessionData = {
    url,
    postId,
    count: 0,
    target: amount,
    status: 'active',
    startTime: new Date(),
    estimatedEndTime,
    timer: null
  };
  
  // Store in main sessions map
  activeSessions.set(sessionId, sessionData);
  
  // Update search indexes
  if (!searchIndex.byPostId.has(postId)) {
    searchIndex.byPostId.set(postId, new Set());
  }
  searchIndex.byPostId.get(postId).add(sessionId);
  
  // Index URL (normalized to lowercase)
  const normalizedUrl = url.toLowerCase();
  if (!searchIndex.byUrl.has(normalizedUrl)) {
    searchIndex.byUrl.set(normalizedUrl, new Set());
  }
  searchIndex.byUrl.get(normalizedUrl).add(sessionId);
  
  // Prepare request headers
  const headers = {
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate',
    'connection': 'keep-alive',
    'content-length': '0',
    'cookie': cookies,
    'host': 'graph.facebook.com'
  };
  
  // Sharing function
  async function sharePost() {
    const session = activeSessions.get(sessionId);
    
    // Check if session still exists or has been manually stopped
    if (!session || session.status !== 'active') {
      clearInterval(timer);
      return;
    }
    
    try {
      const response = await axios.post(
        `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${postId}&published=0&access_token=${accessToken}`, 
        {}, 
        { headers }
      );
      
      if (response.status === 200) {
        // Update session count
        session.count += 1;
        activeSessions.set(sessionId, session);
        
        logger.success(`Session ${sessionId}: Share ${session.count}/${session.target} completed`);
        
        // Check if target reached
        if (session.count >= session.target) {
          clearInterval(timer);
          session.status = 'completed';
          activeSessions.set(sessionId, session);
          logger.info(`Session ${sessionId} completed: ${session.count} shares done`);
          
          // Clean up session after 1 hour
          setTimeout(() => {
            // Clean up search indexes
            const session = activeSessions.get(sessionId);
            if (session) {
              // Remove from postId index
              if (searchIndex.byPostId.has(session.postId)) {
                searchIndex.byPostId.get(session.postId).delete(sessionId);
                if (searchIndex.byPostId.get(session.postId).size === 0) {
                  searchIndex.byPostId.delete(session.postId);
                }
              }
              
              // Remove from URL index
              const normalizedUrl = session.url.toLowerCase();
              if (searchIndex.byUrl.has(normalizedUrl)) {
                searchIndex.byUrl.get(normalizedUrl).delete(sessionId);
                if (searchIndex.byUrl.get(normalizedUrl).size === 0) {
                  searchIndex.byUrl.delete(normalizedUrl);
                }
              }
            }
            
            // Remove from active sessions
            activeSessions.delete(sessionId);
            logger.info(`Session ${sessionId} removed from active sessions`);
          }, 3600000);
        }
      } else {
        logger.error(`Share failed with status ${response.status}`);
      }
    } catch (error) {
      // Update session status
      session.status = 'error';
      session.error = error.message;
      activeSessions.set(sessionId, session);
      
      logger.error(`Sharing error in session ${sessionId}: ${error.message}`);
      clearInterval(timer);
    }
  }
  
  // Start periodic sharing
  const timer = setInterval(sharePost, interval * 1000);
  activeSessions.get(sessionId).timer = timer;
  
  // Safety timeout to prevent hanging sessions
  const safetyTimeout = setTimeout(() => {
    const session = activeSessions.get(sessionId);
    if (session && session.status === 'active') {
      clearInterval(session.timer);
      session.status = 'timeout';
      activeSessions.set(sessionId, session);
      logger.info(`Session ${sessionId} safety timeout triggered`);
      
      // Clean up session after 1 hour
      setTimeout(() => {
        // Clean up search indexes
        const session = activeSessions.get(sessionId);
        if (session) {
          // Remove from postId index
          if (searchIndex.byPostId.has(session.postId)) {
            searchIndex.byPostId.get(session.postId).delete(sessionId);
            if (searchIndex.byPostId.get(session.postId).size === 0) {
              searchIndex.byPostId.delete(session.postId);
            }
          }
          
          // Remove from URL index
          const normalizedUrl = session.url.toLowerCase();
          if (searchIndex.byUrl.has(normalizedUrl)) {
            searchIndex.byUrl.get(normalizedUrl).delete(sessionId);
            if (searchIndex.byUrl.get(normalizedUrl).size === 0) {
              searchIndex.byUrl.delete(normalizedUrl);
            }
          }
        }
        
        // Remove from active sessions
        activeSessions.delete(sessionId);
        logger.info(`Session ${sessionId} removed from active sessions after timeout`);
      }, 3600000);
    }
  }, (amount * interval * 1000) + 300000); // Add 5 minutes safety margin
  
  return sessionId;
}

/**
 * Extract Facebook post ID from URL
 * @param {string} url - Facebook post URL
 * @returns {string|null} Post ID or null if not found
 */
async function getPostID(url) {
  try {
    const response = await axios.post(
      'https://id.traodoisub.com/api.php', 
      `link=${encodeURIComponent(url)}`, 
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000 // 10 seconds timeout
      }
    );
    
    if (response.data && response.data.id) {
      return response.data.id;
    }
    return null;
  } catch (error) {
    logger.error(`Error getting post ID: ${error.message}`);
    return null;
  }
}

/**
 * Extract Facebook access token from cookies
 * @param {string} cookie - Facebook cookies
 * @returns {string|null} Access token or null if not found
 */
async function getAccessToken(cookie) {
  try {
    const headers = {
      'authority': 'business.facebook.com',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'max-age=0',
      'cookie': cookie,
      'referer': 'https://www.facebook.com/',
      'sec-ch-ua': '".Not/A)Brand";v="99", "Google Chrome";v="103", "Chromium";v="103"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36'
    };
    
    const response = await axios.get('https://business.facebook.com/content_management', {
      headers,
      timeout: 15000 // 15 seconds timeout
    });
    
    const tokenMatch = response.data.match(/"accessToken":\s*"([^"]+)"/);
    if (tokenMatch && tokenMatch[1]) {
      return tokenMatch[1];
    }
    
    // Alternative token extraction pattern if the first one fails
    const altTokenMatch = response.data.match(/accessToken="([^"]+)"/);
    if (altTokenMatch && altTokenMatch[1]) {
      return altTokenMatch[1];
    }
    
    logger.error('Access token not found in Facebook response');
    return null;
  } catch (error) {
    logger.error(`Error getting access token: ${error.message}`);
    return null;
  }
}

/**
 * Convert cookie from JSON format to string format
 * @param {string} cookie - Cookie in JSON format
 * @returns {Promise<string>} Cookie in string format
 */
async function convertCookie(cookie) {
  return new Promise((resolve, reject) => {
    try {
      // Check if cookie is already in string format
      if (typeof cookie === 'string' && cookie.includes('=')) {
        resolve(cookie);
        return;
      }
      
      // Parse JSON format cookies
      const cookies = JSON.parse(cookie);
      
      // Validate cookie format
      if (!Array.isArray(cookies)) {
        reject("Invalid cookie format: expected array");
        return;
      }
      
      // Find essential sb cookie
      const sbCookie = cookies.find(cookie => cookie.key === "sb");
      if (!sbCookie) {
        reject("Missing essential 'sb' cookie");
        return;
      }
      
      // Convert to string format
      const cookieString = `sb=${sbCookie.value}; ${
        cookies
          .filter(cookie => cookie.key !== "sb")
          .map(cookie => `${cookie.key}=${cookie.value}`)
          .join('; ')
      }`;
      
      resolve(cookieString);
    } catch (error) {
      reject(`Error processing cookies: ${error.message}`);
    }
  });
}

/**
 * Dedicated search endpoint for posts with efficient index-based search
 */
app.get('/api/search', (req, res) => {
  try {
    const { term, type } = req.query;
    
    if (!term) {
      return res.status(400).json({ error: 'Search term is required' });
    }
    
    let matchedSessionIds = new Set();
    const searchLower = term.toLowerCase();
    
    // If search type is specified, use the appropriate index
    if (type === 'postId') {
      // Search by post ID - direct lookup from index
      if (searchIndex.byPostId.has(term)) {
        searchIndex.byPostId.get(term).forEach(id => matchedSessionIds.add(id));
      }
      
      // Also do a partial match search on post IDs
      searchIndex.byPostId.forEach((sessions, postId) => {
        if (postId.includes(term)) {
          sessions.forEach(id => matchedSessionIds.add(id));
        }
      });
    } 
    else if (type === 'url') {
      // Search by URL - use URL index
      searchIndex.byUrl.forEach((sessions, url) => {
        if (url.includes(searchLower)) {
          sessions.forEach(id => matchedSessionIds.add(id));
        }
      });
    }
    else {
      // Generic search - try all indexes and session IDs
      
      // Check post ID index
      searchIndex.byPostId.forEach((sessions, postId) => {
        if (postId.includes(term)) {
          sessions.forEach(id => matchedSessionIds.add(id));
        }
      });
      
      // Check URL index
      searchIndex.byUrl.forEach((sessions, url) => {
        if (url.includes(searchLower)) {
          sessions.forEach(id => matchedSessionIds.add(id));
        }
      });
      
      // Check session IDs
      activeSessions.forEach((session, sessionId) => {
        if (sessionId.toLowerCase().includes(searchLower)) {
          matchedSessionIds.add(sessionId);
        }
      });
    }
    
    // Convert results to array with full details
    const results = Array.from(matchedSessionIds)
      .filter(sessionId => activeSessions.has(sessionId))
      .map(sessionId => {
        const session = activeSessions.get(sessionId);
        return {
          sessionId,
          url: session.url,
          postId: session.postId,
          count: session.count,
          target: session.target,
          progress: Math.round((session.count / session.target) * 100),
          status: session.status,
          startTime: session.startTime,
          estimatedEndTime: session.estimatedEndTime
        };
      });
    
    logger.info(`Advanced search performed with term: "${term}"${type ? `, type: ${type}` : ''}, found ${results.length} results`);
    
    res.json({
      term,
      type: type || 'all',
      count: results.length,
      results
    });
  } catch (error) {
    logger.error(`Search error: ${error.message}`);
    res.status(500).json({ error: 'Search operation failed' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  logger.info(`ShareBoost server started on port ${PORT}`);
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
  logger.info('Shutting down ShareBoost server...');
  
  // Stop all active sessions
  for (const [sessionId, session] of activeSessions.entries()) {
    if (session.timer) {
      clearInterval(session.timer);
      logger.info(`Stopped session ${sessionId}`);
    }
  }
  
  process.exit(0);
});

// Error handling for unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});
