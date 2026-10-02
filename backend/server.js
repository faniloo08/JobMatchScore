import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import 'dotenv/config';

const app = express();
app.use(express.json());
app.use(cors());

const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_KEY_2 = process.env.GROQ_API_KEY_2;

const SYSTEM_PROMPT =
  "Tu es un assistant RH qui évalue l'adéquation entre un candidat et une offre d'emploi. Tu réponds UNIQUEMENT en JSON valide, sans texte avant ni après.";

// --- Liste des fournisseurs, essayés dans l'ordre ---
function buildProviders() {
  const providers = [];

  // OpenRouter — plusieurs modèles gratuits en cascade
  if (OPENROUTER_KEY) {
    // Modèle principal gratuit
    providers.push({
      name: "OpenRouter (Gemma 4)",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: OPENROUTER_KEY,
      model: "google/gemma-4-31b-it:free",
      extraHeaders: {
        "HTTP-Referer": "https://jobmatchscore.onrender.com/",
        "X-Title": "JobMatch-AI"
      }
    });

    // Fallback OpenRouter — autre modèle gratuit
    providers.push({
      name: "OpenRouter (Llama 3.1 8B)",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: OPENROUTER_KEY,
      model: "meta-llama/llama-3.1-8b-instruct:free",
      extraHeaders: {
        "HTTP-Referer": "https://jobmatchscore.onrender.com/",
        "X-Title": "JobMatch-AI"
      }
    });
  }

  // Groq — llama-3.3-70b-versatile est le bon ID officiel (confirmé oct 2026)
  if (GROQ_API_KEY) {
    providers.push({
      name: "Groq (cle 1)",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: GROQ_API_KEY,
      model: "llama-3.3-70b-versatile"
    });
  }
  if (GROQ_API_KEY_2) {
    providers.push({
      name: "Groq (cle 2)",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: GROQ_API_KEY_2,
      model: "llama-3.3-70b-versatile"
    });
  }

  // Dernier fallback Groq — modèle plus léger qui a plus de chances d'être dispo
  if (GROQ_API_KEY) {
    providers.push({
      name: "Groq (llama-3.1-8b)",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: GROQ_API_KEY,
      model: "llama-3.1-8b-instant"
    });
  }

  return providers;
}

function extractJson(str) {
  const match = str.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let json = match[0];
  json = json.replace(/";/g, '",');
  // Supprime les caracteres de controle problematiques, en gardant \t \n \r
  json = Array.from(json).filter(function(c){var k=c.charCodeAt(0);if(k===9||k===10||k===13)return true;if(k<32)return false;if(k>=127&&k<=159)return false;return true;}).join("");
  json = json.replace(/,\s*([\]}])/g, "$1");

  try {
    return JSON.parse(json);
  } catch (e) {
    console.error("[extractJson] Echec du parsing:", e.message, "\nJSON brut:", json.slice(0, 300));
    return null;
  }
}

// Petit helper pour attendre N ms
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Appelle un fournisseur unique. Gère le retry sur 429 (rate limit).
async function callProvider(provider, prompt, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${provider.key}`,
        "Content-Type": "application/json",
        ...(provider.extraHeaders || {})
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json().catch(() => null);

    // Si rate-limité (429), on attend et on réessaie
    if (response.status === 429 && attempt < retries) {
      const waitSec = (attempt + 1) * 5; // 5s, 10s
      console.warn(`⏳ ${provider.name}: rate-limit (429), retry dans ${waitSec}s... (tentative ${attempt + 1}/${retries})`);
      await sleep(waitSec * 1000);
      continue;
    }

    // Autre erreur HTTP
    if (!response.ok) {
      const apiMsg = data?.error?.message || JSON.stringify(data);
      throw new Error(`HTTP ${response.status} — ${apiMsg}`);
    }

    const raw = data?.choices?.[0]?.message?.content || "";
    if (!raw) {
      throw new Error("reponse vide du modele");
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      throw new Error(`JSON invalide renvoye par le modele: ${raw.slice(0, 200)}`);
    }

    return parsed;
  }

  throw new Error("Rate-limit persistant apres retries");
}

app.post("/analyze", async (req, res) => {
  const { candidate, offer } = req.body;

  const prompt = `
Analyse la compatibilité entre le profil du candidat et l'offre d'emploi suivante, et attribue un score d'adéquation compris entre 0 et 100.

Évalue précisément :
1. Les compétences techniques et fonctionnelles mentionnées.
2. Les années d'expérience et le niveau du candidat (Junior, Confirmé, Sénior), surtout pour les postes de développeur.
3. La correspondance du poste visé, du secteur d'activité et des responsabilités.
4. La cohérence entre les soft skills attendues et celles du candidat.
5. Le niveau d'étude ou de certification si présent.

⚙️ Barème suggéré :
- 70–100 : Très bonne adéquation
- 40–69 : Adéquation moyenne
- 0–39 : Faible adéquation

Voici les données :

CANDIDAT:
${JSON.stringify(candidate, null, 2)}

OFFRE:
${JSON.stringify(offer, null, 2)}

Réponds sous ce format JSON:
{ "score": number, "verdict": string, "reasons": [string] }
`;

  const providers = buildProviders();

  if (providers.length === 0) {
    console.error("❌ Aucune cle API configuree (OPENROUTER_KEY / GROQ_API_KEY / GROQ_API_KEY_2).");
    return res.status(500).json({ error: "Aucun fournisseur LLM configure cote serveur." });
  }

  const failures = [];

  // Cascade : on essaie chaque fournisseur jusqu'au premier succes.
  for (const provider of providers) {
    try {
      const parsed = await callProvider(provider, prompt);
      console.log(`✅ Analyse reussie via ${provider.name} (modele ${provider.model}).`);
      return res.json(parsed);
    } catch (err) {
      console.warn(`⚠️ Echec via ${provider.name}: ${err.message}`);
      failures.push(`${provider.name}: ${err.message}`);
    }
  }

  // Tous les fournisseurs ont echoue.
  console.error("❌ Tous les fournisseurs LLM ont echoue:\n" + failures.join("\n"));
  return res.status(502).json({
    error: "Tous les fournisseurs LLM ont echoue",
    details: failures
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
