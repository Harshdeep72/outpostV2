const https = require('https');
https.get('https://old.reddit.com/r/CyberSecurityAdvice/comments/1u12o3r/.json', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
}, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log(data.substring(0, 500)));
});
