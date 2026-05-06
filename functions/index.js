const { onRequest } = require('firebase-functions/v2/https');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

exports.groqProxy = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === '') {
    console.error('GROQ_API_KEY not found in environment');
    res.status(500).json({ error: { message: 'Groq API key not configured' } });
    return;
  }


  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : 'llama-3.3-70b-versatile';
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const temperature = typeof payload.temperature === 'number' ? payload.temperature : 0.4;
    const maxTokens = Number.isFinite(payload.max_tokens) ? payload.max_tokens : 900;

    const upstream = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      })
    });

    const text = await upstream.text();
    res.status(upstream.status);
    if (text) {
      res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
      res.send(text);
    } else {
      res.send('');
    }
  } catch (error) {
    console.error('groqProxy failed', error);
    res.status(500).json({ error: { message: 'Failed to reach Groq' } });
  }
});