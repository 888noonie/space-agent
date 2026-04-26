import { applyApiCorsHeaders } from "../router/cors.js";

export const handlers = {
  async get({ query, res }) {
    const targetUrl = query.url || 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM3M'; // Default to a chill playlist
    
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      if (!response.ok) throw new Error(`Upstream returned ${response.status}`);

      let body = await response.text();
      
      // Inject a small script to keep links within the iframe if possible
      body = body.replace('</head>', '<base target="_self"></head>');

      applyApiCorsHeaders(res);
      
      // Explicitly remove security headers
      res.setHeader('Content-Security-Policy', '');
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      
      return body;
    } catch (error) {
      res.statusCode = 502;
      return { error: `Proxy failed: ${error.message}` };
    }
  }
};
