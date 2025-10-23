import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import 'dotenv/config';

const app = express();
app.use(express.json());
app.use(cors());

const OPENROUTER_KEY = process.env.OPENROUTER_KEY; // stocke ta clé ici

app.post("/analyze", async (req, res) => {
  try {
    const { candidate, offer } = req.body;

    const prompt = `
Compare le profil du candidat et l'offre suivante et renvoie un score d’adéquation (0 à 100)
et un résumé synthétique. Voici les données :

CANDIDAT:
${JSON.stringify(candidate, null, 2)}

OFFRE:
${JSON.stringify(offer, null, 2)}

Réponds sous ce format JSON:
{ "score": number, "verdict": string, "reasons": [string] }
`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.3-8b-instruct:free",
        messages: [
          { role: "system", content: "Tu es un assistant RH qui évalue l’adéquation entre un candidat et une offre d’emploi." },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || "{}";

    // Nettoyer la chaîne : supprimer tout avant/après le bloc JSON
    content = content.trim();

    // Si le texte contient un bloc JSON, on l’extrait
    const match = content.match(/{[\s\S]*}/);
    if (match) {
      content = match[0];
    }

    // Supprimer les backticks ou autres caractères parasites
    content = content.replace(/`/g, "").replace(/^```json|```$/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.error("⚠️ Échec du parsing JSON:", content);
      parsed = { error: "Invalid JSON from model", raw: content };
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(5000, () => console.log("✅ Backend running on port 5000"));
