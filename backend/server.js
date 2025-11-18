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
Analyse la compatibilité entre le profil du candidat et l'offre d'emploi suivante, et attribue un score d’adéquation compris entre 0 et 100.

Évalue précisément :
1. Les compétences techniques et fonctionnelles mentionnées.
2. Les années d’expérience et le niveau du candidat (Junior, Confirmé, Sénior), surtout pour les postes de développeur.
3. La correspondance du poste visé, du secteur d’activité et des responsabilités.
4. La cohérence entre les soft skills attendues et celles du candidat.
5. Le niveau d’étude ou de certification si présent.

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
    function extractJson(str) {
      // Trouve le premier vrai bloc JSON
      const match = str.match(/\{[\s\S]*\}/);
      if (!match) return null;

      let json = match[0];

      // Remplace les ; par des , sauf s'ils sont à l'intérieur d'un mot
      json = json.replace(/";/g, "\",");
      json = json.replace(/";/g, "\",");

      // Supprime caractères invisibles unicode
      json = json.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

      // Supprime trailing commas
      json = json.replace(/,\s*([\]}])/g, "$1");

      try {
        return JSON.parse(json);
      } catch (e) {
        return null;
      }
    }

    //Appel modèle
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://srv1057289.hstgr.cloud:5000/",
        "X-Title": "JobMatch-AI"
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3-8b-instruct",
        messages: [
          { role: "system", content: "Tu es un assistant RH qui évalue l’adéquation entre un candidat et une offre d’emploi." },
          { role: "user", content: prompt }
        ]
      })
    });


    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "";

    // ⭐ Extraction ultra robuste
    const parsed = extractJson(raw);

    if (!parsed) {
      return res.json({
        error: "Invalid JSON from model",
        raw
      });
    }

    // 👍 Si tout va bien
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



app.listen(5000, () => console.log("✅ Backend running on port 5000"));
