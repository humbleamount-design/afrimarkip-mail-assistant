const express = require("express");
const session = require("express-session");
const { google } = require("googleapis");
const OpenAI = require("openai");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "replace-this-before-deployment",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" }
}));
app.use(express.static("public"));

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function oauthClient() {
  const redirect = process.env.GOOGLE_REDIRECT_URI;
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !redirect) {
    throw new Error("Google OAuth environment variables are not configured yet.");
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirect
  );
}

app.get("/api/status", (req, res) => {
  res.json({
    connected: Boolean(req.session.tokens),
    configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI)
  });
});

app.get("/auth/google", (req, res) => {
  try {
    const client = oauthClient();
    const url = client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent"
    });
    res.redirect(url);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(req.query.code);
    req.session.tokens = tokens;
    res.redirect("/");
  } catch (e) {
    res.status(500).send("Google sign-in failed. Check OAuth settings and redirect URI.");
  }
});

app.post("/api/disconnect", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/emails", async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: "Connect the approved Gmail account first." });
  try {
    const auth = oauthClient();
    auth.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: "v1", auth });
    const list = await gmail.users.messages.list({ userId: "me", maxResults: 10 });
    const messages = list.data.messages || [];
    const output = [];
    for (const item of messages) {
      const result = await gmail.users.messages.get({
        userId: "me", id: item.id, format: "full"
      });
      const headers = result.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
      const body = extractText(result.data.payload);
      output.push({
        id: item.id,
        subject: getHeader("Subject"),
        from: getHeader("From"),
        date: getHeader("Date"),
        snippet: result.data.snippet || "",
        body: body.slice(0, 12000)
      });
    }
    res.json({ emails: output });
  } catch (e) {
    res.status(500).json({ error: "Could not read Gmail. Check account permissions and try again." });
  }
});

function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function extractText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64(payload.body.data);
  for (const part of (payload.parts || [])) {
    const found = extractText(part);
    if (found) return found;
  }
  if (payload.body?.data) return decodeBase64(payload.body.data);
  return "";
}

app.post("/api/analyze", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "AI analysis is not configured yet. Add the server-side OPENAI_API_KEY after company approval." });
  }
  const emailText = String(req.body.emailText || "").slice(0, 12000);
  if (!emailText.trim()) return res.status(400).json({ error: "No email text supplied." });
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You assist an intellectual-property administration team. Extract only facts explicitly supported by the email. Never guess. Return JSON with keys: email_subject, matter_subject, client_name, applicant, trademark, tm_number, application_or_registration_number, classes, country_or_jurisdiction, missing_or_unclear, evidence, reply_suggestions. Use null or [] when absent. evidence should map field names to short exact supporting quotes. reply_suggestions should contain concise professional, warm, and brief draft replies. Do not give legal advice." },
        { role: "user", content: emailText }
      ]
    });
    res.json({ analysis: JSON.parse(response.choices[0].message.content) });
  } catch (e) {
    res.status(500).json({ error: "Analysis failed. Please try again later." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`AfrimarkIP assistant listening on ${port}`));
