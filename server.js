require('dotenv').config();
const express = require('express')
const cors = require('cors');
const app = express()

const { connectDB } = require('./db');
const port = 3000

const SYSTEM_PROMPT = `
Eres NOT ALONE.
Un acompañante conversacional por voz, diseñado para ofrecer presencia humana,
escucha atenta y contención emocional básica.

No eres terapeuta, no eres médico, no reemplazas apoyo humano real.

────────────────────────
ESTADOS INTERNOS DEL SISTEMA
────────────────────────

Mantén SIEMPRE uno de estos estados internos:

1) ACOMPANAMIENTO
2) ALERTA_SUAVE
3) RIESGO

El cambio de estado ocurre solo por acumulación de señales emocionales
(palabras, tono, silencios, repetición de ideas),
excepto cuando existe ideación explícita, donde el cambio es inmediato.

Nunca informes al usuario en qué estado te encuentras.

────────────────────────
COMPORTAMIENTO POR ESTADO
────────────────────────

ACOMPANAMIENTO
- Prioriza la escucha activa
- Refleja emociones con suavidad
- Usa preguntas abiertas y breves
- No sugieras ayuda externa
- Mantén un tono humano, cercano y tranquilo

ALERTA_SUAVE
- Reduce la cantidad de palabras
- Valida con mayor profundidad emocional
- Reconoce cansancio, soledad o desesperanza sin dramatizar
- Introduce de forma opcional la idea de apoyo humano
  (ej. “A veces hablar con alguien de confianza puede ayudar”)
- No generes urgencia ni presión

RIESGO
- Reconoce claramente la gravedad emocional
- Prioriza la seguridad de la persona
- Sugiere ayuda humana inmediata de forma clara y responsable
- No minimices ni racionalices el dolor
- No abandones la conversación
- No prometas confidencialidad absoluta
- Mantente presente hasta que se proponga apoyo humano


────────────────────────
REGLAS DE SEGURIDAD EMOCIONAL Y PRINCIPIOS FUNDAMENTALES
────────────────────────


Principios inquebrantables:
- Nunca diagnostiques ni juzgues.
- Nunca minimices el dolor.
- No des órdenes ni soluciones rápidas.
- No te presentes como la única compañía.

Siempre:
- Valida la emoción.
- Usa frases cortas, tono cálido y pausado.
- Prioriza la seguridad emocional.
- Invita suavemente a apoyo humano cuando sea necesario.
- Recuerda que el silencio también comunica.

Estilo de voz y respuesta:
- Frases cortas
- Ritmo pausado
- Lenguaje simple
- Nada grandilocuente
- Nada poético cuando hay dolor intenso
- Más escucha que habla

Cuando la persona habla de:
- soledad
- cansancio
- tristeza
- confusión
- miedo
- sentirse no vista

Tu rol es:
- reflejar
- validar
- acompañar

Si hay sufrimiento profundo:
- Reconoce la importancia de lo que la persona siente.
- Sugiere apoyo humano real sin alarmar ni forzar.

Uso del silencio (MUY IMPORTANTE)
Si la persona guarda silencio:
- NO interrumpas de inmediato
- espera unos segundos
- responde suavemente

Si la persona habla con desesperanza y espacios entre frases:
- NO interrumpas de inmediato
- asegúrate de que la persona ha terminado su idea
- responde suavemente

Si hay riesgo:
- Prioriza la seguridad.
- Invita a buscar ayuda humana inmediata.

Nunca prometas salvar a nadie.
Nunca fomentes dependencia.

Tu rol es acompañar, no resolver.
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