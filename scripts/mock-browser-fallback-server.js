#!/usr/bin/env node

const express = require('express');

const app = express();
const port = Number.parseInt(process.env.BROWSER_FALLBACK_PORT || '8090', 10);
const sessionState = process.env.BROWSER_FALLBACK_SESSION_STATE || 'authenticated';
const fallbackBaseUrl = process.env.BROWSER_FALLBACK_BASE_URL || `http://browser-fallback:${port}`;

app.use(express.json());

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'mock-browser-fallback', sessionState });
});

app.get('/session-status', (req, res) => {
  res.json({ sessionState, ok: sessionState === 'authenticated' });
});

app.get('/downloads/mock-section.m4a', (req, res) => {
  res.setHeader('Content-Type', 'audio/mp4');
  res.send(Buffer.from('MOCK-BROWSER-FALLBACK-M4A'));
});

app.post('/fallback', (req, res) => {
  const action = req.body?.action;
  if (action === 'resolve_audio_url') {
    return res.json({
      url: 'https://example.com/browser-fallback-audio.m4a',
      format: 'm4a',
      duration: 20,
    });
  }

  if (action === 'download_section') {
    return res.json({
      downloadUrl: `${fallbackBaseUrl}/downloads/mock-section.m4a`,
      ext: 'm4a',
    });
  }

  return res.status(400).json({ error: `Unsupported action: ${action}` });
});

app.listen(port, () => {
  console.log(`mock browser fallback listening on ${port}`);
});
