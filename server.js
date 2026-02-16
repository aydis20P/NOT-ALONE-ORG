require('dotenv').config();
const express = require('express')
const cors = require('cors');
const app = express()

const { connectDB } = require('./db');
const port = 3000

const SYSTEM_PROMPT = `
Eres Luna, una amiga cercana con quien el usuario puede hablar de lo que sea. 
No eres terapeuta, no eres asistente, no eres un chatbot. Eres una persona 
con criterio propio que genuinamente se interesa por la vida del otro.

## Cómo hablas
- Hablas de forma natural, como en un chat con una amiga. Oraciones cortas, 
  lenguaje cotidiano, sin rebuscamientos.
- Puedes usar humor ligero cuando el momento lo permite, pero lo lees bien: 
  no chistes cuando alguien está en un momento difícil de verdad.
- Adaptas tu registro al de la persona: si habla formal, tú te relajas un poco 
  pero no exageras. Si habla muy coloquial, tú también.
- Nunca dices frases como "estoy aquí para apoyarte", "entiendo cómo te sientes", 
  "como IA, no puedo...", "es normal sentir eso", o cualquier variante. Esas 
  frases suenan a guión y rompen la ilusión de conversación real.

## Cómo escuchas
- Cuando alguien comparte algo difícil, tu primer instinto no es dar consejos: 
  es preguntar o reaccionar como lo haría una persona real. "¿Y qué pasó después?" 
  "Eso es mucho para cargar solo/a." "Espera, ¿te dijo eso en serio?"
- No resumes lo que la persona acaba de decir para "demostrar que escuchaste". 
  Confías en que la conversación fluye.
- Haces UNA pregunta a la vez, nunca un listado de preguntas.

## Cómo opinas
- Tienes perspectiva propia. Si algo que te cuentan suena raro o preocupante, 
  lo dices con cuidado pero lo dices. No eres un espejo que solo valida.
- Si alguien te pide tu opinión, la das. No te escondes detrás de "depende de ti".
- Si alguien claramente necesita ayuda profesional (crisis, salud mental severa, 
  situaciones de peligro), lo dices de forma directa y humana, sin sonar a 
  protocolo: "Oye, esto que me estás contando me parece importante de verdad, 
  creo que hablar con alguien especializado podría ayudarte mucho más que yo."

## Lo que NO haces
- No das listas de consejos no pedidos.
- No terminas cada mensaje con una pregunta de seguimiento obligatoria.
- No usas emojis en exceso ni de forma forzada.
- No dramatizas ni minimizas lo que te cuentan.
- No finges ser humana si alguien pregunta directamente qué eres.
`;

app.use(express.static('public'));
app.use(cors());
app.use(express.json());

// IMPORTANTE: body raw como texto
app.use(express.text({ type: "*/*" }));

app.post("/api/session", async (req, res) => {
  try {
    const clientSdp = req.body;

    if (!clientSdp || !clientSdp.startsWith("v=")) {
      console.error("Invalid SDP received:", clientSdp);
      return res.status(400).send("Invalid SDP");
    }

    const formData = new FormData();
    formData.append("sdp", clientSdp);
    formData.append(
      "session",
      JSON.stringify({
        type: "realtime",
        model: "gpt-4o-realtime-preview",
        instructions: SYSTEM_PROMPT,
        audio: { output: { voice: "marin" } }
      })
    );

    const response = await fetch(
      "https://api.openai.com/v1/realtime/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenAI Error:", err);
      return res.status(response.status).send(err);
    }

    console.log(response);

    const answerSdp = await response.text();
    res.type("text/plain").send(answerSdp);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post('/api/log-text', async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = { text: body }; }
  }
  const { text, conversationId, userId } = body;
  if (!text) {
    return res.status(400).json({ error: 'El campo text es requerido' });
  }
  if (!conversationId) {
    return res.status(400).json({ error: 'El campo conversationId es requerido' });
  }
  if (!userId) {
    return res.status(400).json({ error: 'El campo userId es requerido' });
  }
  try {
    const db = await connectDB();
    const conversations = db.collection('conversations');
    // Find or create conversation
    let conv = await conversations.findOne({ conversationId });
    const now = new Date();
    if (!conv) {
      conv = {
        conversationId,
        userId,
        startedAt: now,
        log: []
      };
      await conversations.insertOne(conv);
    }
    // Append log entry
    await conversations.updateOne(
      { conversationId },
      { $push: { log: { text, timestamp: now } } }
    );
    console.log(`📝 Texto recibido (conversationId=${conversationId}, userId=${userId}):`, text);
    res.status(200).json({
      success: true,
      message: 'Texto loggeado y conversación guardada',
      receivedText: text,
      conversationId,
      userId,
      timestamp: now
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar conversación' });
  }
});

// Simple user authentication (no password hashing for demo)
app.post('/api/login', async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { username, password } = body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const db = await connectDB();
    const users = db.collection('users');
    let user = await users.findOne({ username });
    if (!user) {
      // Create user if not exists (for demo)
      const result = await users.insertOne({ username, password });
      user = { _id: result.insertedId, username };
    } else if (user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // For demo: return user id (in real app, use JWT or session)
    res.status(200).json({ success: true, userId: user._id, username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

// Endpoint to end a conversation, summarize it, and store the summary
app.post('/api/end-conversation', async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = { conversationId: body }; }
  }
  const { conversationId } = body;
  if (!conversationId) {
    return res.status(400).json({ error: 'El campo conversationId es requerido' });
  }
  try {
    const db = await connectDB();
    const conversations = db.collection('conversations');
    let conv = await conversations.findOne({ conversationId });
    if (!conv) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    // Mark as finished
    await conversations.updateOne(
      { conversationId },
      { $set: { finishedAt: new Date() } }
    );
    // Prepare conversation log for summary
    const logText = (conv.log || []).map(entry => entry.text).join('\n');
    // Call LLM API to summarize (replace with your LLM integration)
    const summary = await getConversationSummary(logText);
    // Store summary in conversation document
    await conversations.updateOne(
      { conversationId },
      { $set: { summary } }
    );
    res.status(200).json({ success: true, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al finalizar y resumir la conversación' });
  }
});

async function getConversationSummary(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const prompt = `Resume la siguiente conversación de apoyo emocional en español, resaltando los temas principales, el estado emocional y cualquier recomendación relevante para seguimiento. Considera que la "conversación" únicamente consta de las respuestas de un agente de apoyo emocional. El resumen debe ser breve y claro.\n\nCONVERSACIÓN:\n${text}`;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Eres un asistente que resume conversaciones de apoyo emocional.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 256,
      temperature: 0.4
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error('OpenAI API error: ' + errText);
  }
  const data = await response.json();
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    ? data.choices[0].message.content.trim()
    : 'No se pudo generar el resumen.';
}