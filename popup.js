let candidateData = null;
let analysisResults = null;
let candidateTabId = null; // 🔥 Stocker l'ID de l'onglet du candidat

document.getElementById('analyzeBtn').addEventListener('click', analyzeMatch);
document.getElementById('cancelBtn').addEventListener('click', closeExtension);
document.getElementById('newAnalysisBtn').addEventListener('click', backToInput);
document.getElementById('closeBtn').addEventListener('click', closeExtension);

// Au chargement du popup, extraire les données du candidat
window.addEventListener('load', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    
    chrome.tabs.sendMessage(tabs[0].id, { action: 'extractCandidate' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Content script pas prêt, tentative en attente...');
        // Réessayer après 500ms
        setTimeout(() => {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'extractCandidate' }, (retryResponse) => {
            if (retryResponse && retryResponse.success) {
              candidateData = retryResponse.data;
              console.log('Données du candidat extraites:', candidateData);
            }
          });
        }, 500);
      } else if (response && response.success) {
        candidateData = response.data;
        console.log('Données du candidat extraites:', candidateData);
      }
    });
  });
});

async function analyzeMatch() {
  const offerUrl = document.getElementById('offerUrl').value.trim();

  if (!offerUrl) {
    alert('Veuillez entrer une URL valide');
    return;
  }

  if (!candidateData) {
    alert('Impossible d\'extraire les données du candidat');
    return;
  }

  showLoading();
  
  try {
    // ✅ Sauvegarde l'onglet candidat avant d'en ouvrir un nouveau
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const candidateTabId = activeTab?.id;

    // Créer un onglet temporaire pour charger l'offre
    chrome.tabs.create({ url: offerUrl, active: false }, (tab) => {
      let attempts = 0;
      const maxAttempts = 30; // 30 tentatives * 500ms = 15 secondes

      const tryExtractOffer = async () => {
        attempts++;
        console.log(`Tentative ${attempts}/${maxAttempts} d'extraction de l'offre...`);

        chrome.tabs.sendMessage(tab.id, { action: 'extractOffer' }, async (response) => {
          if (chrome.runtime.lastError) {
            // Erreur - le content script n'est pas prêt
            if (attempts < maxAttempts) {
              setTimeout(tryExtractOffer, 500);
            } else {
              showError('Timeout: impossible de charger l\'offre.');
              chrome.tabs.remove(tab.id).catch(() => {});
            }
          } else if (response && response.success) {
            // Succès !
            const offerData = response.data;
            console.log('✅ Données de l\'offre extraites:', offerData);

            try {
              // 🔥 Appel IA à ton backend Meta
              const res = await fetch("https://jobmatchscore.onrender.com/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ candidate: candidateData, offer: offerData })
              });

              const analysisResults = await res.json();
              console.log('🤖 Résultats d\'analyse:', analysisResults);

              // ✅ Vérifier que la réponse est valide (pas une erreur du backend)
              if (!analysisResults || analysisResults.error || typeof analysisResults.score !== 'number') {
                console.error('❌ Réponse invalide du backend:', analysisResults);
                showError('Erreur d\'analyse : réponse invalide du serveur IA.');
                return;
              }

              displayResult(analysisResults);

              // Injecter le score dans la page du candidat (onglet sauvegardé)
              if (candidateTabId) {
                chrome.tabs.sendMessage(candidateTabId, {
                  action: "insertScore",
                  score: analysisResults.score
                });
              } else {
                console.warn('⚠️ candidateTabId introuvable, injection du score ignorée.');
              }
            } catch (err) {
              console.error('Erreur IA:', err);
              showError('Erreur pendant l\'analyse IA.');
            }

            // Fermer l'onglet temporaire
            chrome.tabs.remove(tab.id).catch(() => {});
          }
        });
      };

      // Attendre 3 secondes avant la première tentative (le temps que la page charge complètement)
      setTimeout(tryExtractOffer, 3000);
    });
  } catch (error) {
    console.error('Erreur lors de l\'analyse:', error);
    showError('Erreur lors de l\'analyse. Vérifiez l\'URL.');
  }
}


function extractOfferData(doc) {
  const offer = {
    requirements: '',
    experience: '',
    salary: '',
    skills: []
  };

  // Extraire la description du profil recherché
  const profileSection = doc.querySelector('.cmqlx');
  if (profileSection) {
    offer.requirements = profileSection.innerText;
  }

  // Extraire le niveau d'expérience requis
  const expBadges = doc.querySelectorAll('.cmqlt');
  if (expBadges.length > 0) {
    offer.experience = expBadges[0].textContent?.trim();
  }

  // Extraire le salaire
  const salaryBadge = doc.querySelector('.cmqlaO0');
  if (salaryBadge) {
    offer.salary = salaryBadge.textContent?.trim();
  }

  return offer;
}

function analyzeCompatibility(candidate, offer) {
  const results = {
    score: 0,
    verdict: '',
    insights: [],
    warnings: []
  };

  let score = 50; // Base score

  // Analyse 1: Compétences correspondantes
  const offerKeywords = extractKeywords(offer.requirements);
  const matchedSkills = candidate.skills.filter(skill =>
    offerKeywords.some(kw => skill.toLowerCase().includes(kw.toLowerCase()))
  );

  if (matchedSkills.length > 0) {
    score += matchedSkills.length * 10;
    results.insights.push({
      type: 'check',
      text: `${matchedSkills.length} compétence(s) correspondante(s): ${matchedSkills.join(', ')}`
    });
  } else {
    results.warnings.push({
      type: 'warning',
      text: 'Peu de compétences explicitement mentionnées'
    });
  }

  // Analyse 2: Expérience en années
  const candidateExpYears = extractExperienceYears(candidate.experiences);
  const requiredExpMatch = offer.experience && offer.experience.includes('3 à 5');

  if (requiredExpMatch && candidateExpYears >= 3) {
    score += 15;
    results.insights.push({
      type: 'check',
      text: `Expérience suffisante: ${candidateExpYears} ans`
    });
  } else if (candidateExpYears >= 1) {
    score += 8;
    results.warnings.push({
      type: 'warning',
      text: `Expérience: ${candidateExpYears} ans (peut être inférieure aux attentes)`
    });
  }

  // Analyse 3: Domaines d'activité pertinents
  const recentRole = candidate.experiences[0];
  if (recentRole) {
    const relevantKeywords = ['lead generation', 'business development', 'sales', 'marketing', 'growth', 'digital'];
    const roleMatch = relevantKeywords.some(kw =>
      (recentRole.title + ' ' + recentRole.description).toLowerCase().includes(kw)
    );

    if (roleMatch) {
      score += 10;
      results.insights.push({
        type: 'check',
        text: `Rôle récent pertinent: ${recentRole.title}`
      });
    } else {
      results.warnings.push({
        type: 'warning',
        text: `Domaine potentiellement moins aligné: ${recentRole.title}`
      });
    }
  }

  // Analyse 4: Localisation
  if (candidate.experiences.length > 0) {
    const location = candidate.experiences[0].location;
    if (location && (location.includes('France') || location.includes('Remote'))) {
      score += 5;
      results.insights.push({
        type: 'check',
        text: `Localisation favorable: ${location}`
      });
    } else if (location) {
      results.warnings.push({
        type: 'warning',
        text: `Localisation: ${location} (vérifier la possibilité de relocalisation)`
      });
    }
  }

  // Cap le score entre 0 et 100
  score = Math.min(Math.max(score, 0), 100);
  results.score = score;

  // Déterminer le verdict
  if (score >= 75) {
    results.verdict = 'Excellent match';
  } else if (score >= 60) {
    results.verdict = 'Bon match';
  } else if (score >= 45) {
    results.verdict = 'Match moyen';
  } else {
    results.verdict = 'Match faible';
  }

  return results;
}

function extractKeywords(text) {
  const keywords = [
    'digital marketing', 'marketing', 'ads', 'lead', 'generation', 'growth',
    'crm', 'automation', 'sales', 'business development', 'prospection',
    'facebook', 'google', 'analytics', 'copywriting', 'content', 'community'
  ];
  return keywords;
}

function extractExperienceYears(experiences) {
  if (experiences.length === 0) return 0;
  
  let totalYears = 0;
  experiences.forEach(exp => {
    const match = exp.duration?.match(/(\d+)/g);
    if (match) {
      match.forEach((num, idx) => {
        if (idx === 0 && num <= 30) totalYears += parseInt(num);
      });
    }
  });
  
  return Math.min(totalYears, experiences.length * 5); // Max 5 ans par expérience
}

function showLoading() {
  const inputScreen = document.getElementById('inputScreen');
  const resultScreen = document.getElementById('resultScreen');
  
  inputScreen.classList.add('hidden');
  resultScreen.classList.add('active');
  
  const content = resultScreen.querySelector('#resultContent');
  content.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p style="margin-top: 16px; color: #64748b; font-size: 14px;">Analyse en cours...</p>
    </div>
  `;
}

function displayResult(results) {
  const resultScreen = document.getElementById('resultScreen');
  const content = resultScreen.querySelector('#resultContent');

  // Déterminer la couleur en fonction du score
  let scoreColor;
  if (results.score < 40) {
    scoreColor = '#ef4444'; // rouge
  } else if (results.score < 70) {
    scoreColor = '#eab308'; // jaune
  } else {
    scoreColor = '#22c55e'; // vert
  }
  

  const itemsHtml = (results.reasons || []).map(r => {
    // Vérifier si c'est un point négatif (commence par "Cependant")
    const isNegative = r.trim().startsWith('Cependant');
    const icon = isNegative ? '✗' : '✓';
    const iconColor = isNegative ? '#ef4444' : '#22c55e';
    
    return `
      <div class="summary-item">
        <span class="check" style="color: ${iconColor};">${icon}</span>
        <span>${r}</span>
      </div>
    `;
  }).join('');

  content.innerHTML = `
    <div class="score-box">
      <div class="score-label">Score d'adéquation</div>
      <div class="score-circle">
        <div style="text-align: center; margin-top: 45px;">
          <div class="score-percent" style="color: ${scoreColor};">${results.score}</div>
          <div class="score-unit" style="color: ${scoreColor};">%</div>
        </div>
      </div>
      <div class="verdict" style="color: ${scoreColor};">
        <span>${results.verdict}</span>
      </div>
    </div>
    <div class="summary-box">
      <div class="summary-title">Analyse IA</div>
      <div>${itemsHtml}</div>
    </div>
  `;
}



function showError(message) {
  const resultScreen = document.getElementById('resultScreen');
  const inputScreen = document.getElementById('inputScreen');
  const content = resultScreen.querySelector('#resultContent');
  
  inputScreen.classList.remove('hidden');
  resultScreen.classList.remove('active');
  
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.textContent = message;
  
  const formGroup = document.querySelector('.form-group');
  formGroup.parentNode.insertBefore(errorDiv, formGroup);
  
  setTimeout(() => errorDiv.remove(), 5000);
}

function backToInput() {
  document.getElementById('inputScreen').classList.remove('hidden');
  document.getElementById('resultScreen').classList.remove('active');
  document.getElementById('offerUrl').value = '';
}

function closeExtension() {
  window.close();
}

