// ==============================
// content.js — ready to paste
// ==============================

/*
  Rappels :
  - Ce fichier doit être listé dans "content_scripts" de manifest.json (matches pour wink pages).
  - page_inject.js (fichier séparé) doit être listé dans "web_accessible_resources" et présent dans l'extension.
  - Vérifie les permissions host_permissions pour wink.
*/

(function () {
  if (window.__FANILO_CONTENT_LOADED) return;
  window.__FANILO_CONTENT_LOADED = true;

  const DEBUG = true;
  const LOG = (...args) => { if (DEBUG) console.log('[content.js]', ...args); };

  LOG('content.js chargé sur:', window.location.href);

  // ---------------------------
  // Helper : safe queryText
  // ---------------------------
  function textOf(sel, ctx = document) {
    try {
      return ctx.querySelector(sel)?.innerText?.trim() || '';
    } catch (e) { return ''; }
  }

  // ---------------------------
  // 1) Candidate extraction (sync)
  // ---------------------------
  function extractCandidateData() {
    LOG('Extraction candidat ↴');

    const candidate = {
      experiences: [],
      skills: [],
      education: null,
      name: null
    };

    try {
      // experiences (selectors kept from earlier)
      const experienceItems = document.querySelectorAll('.coaXpr');
      LOG('Expériences trouvées:', experienceItems.length);

      experienceItems.forEach((exp) => {
        const title = exp.querySelector('[title]')?.textContent?.trim()
          || exp.querySelector('.coaXqaC')?.textContent?.trim()
          || '';
        const company = exp.querySelector('.coaXqaD')?.textContent?.trim() || '';
        const duration = exp.querySelector('.coaXqaE')?.textContent?.trim() || '';
        const location = exp.querySelector('.coaXqaI')?.textContent?.trim() || '';
        const description = exp.querySelector('.coaXqaK')?.textContent?.trim() || '';

        if (title || company) {
          candidate.experiences.push({
            title: title || 'N/A',
            company: company || 'N/A',
            duration: duration || 'N/A',
            location: location || 'N/A',
            description: description || ''
          });
        }
      });

      // skills
      const skillEls = document.querySelectorAll('.coyik, .skill-tag');
      LOG('Compétences trouvées:', skillEls.length);
      skillEls.forEach(el => {
        const s = el.textContent?.trim();
        if (s) candidate.skills.push(s);
      });

      // education (badge)
      const educationBadge = document.querySelector('.cmqlj, .cmqlt');
      if (educationBadge) candidate.education = educationBadge.textContent?.trim();

      // name (if present)
      candidate.name = textOf('.profile-name, .candidate-name, .coaXName');

    } catch (err) {
      console.error('[content.js] extractCandidateData error', err);
    }

    LOG('Candidate =>', candidate);
    return candidate;
  }

  // ---------------------------
  // 2) Inject page_inject.js into page context (only once)
  // ---------------------------
  function injectPageScript() {
    try {
      if (document.querySelector('script[data-fanilo-injected="1"]')) {
        LOG('page_inject already injected');
        return;
      }
      const script = document.createElement('script');
      script.setAttribute('data-fanilo-injected', '1');
      script.src = chrome.runtime.getURL('page_inject.js');
      script.onload = () => {
        LOG('page_inject.js chargé puis retiré');
        script.remove();
      };
      (document.head || document.documentElement).appendChild(script);
      LOG('Injection de page_inject.js demandée');
    } catch (e) {
      console.error('[content.js] injectPageScript error', e);
    }
  }

  // inject immediately (safe)
  injectPageScript();

  // ---------------------------
  // 3) Listen postMessage from page (page_inject will post job data)
  // ---------------------------
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.source === 'FANILO_EXTENSION' && data.type === 'WINK_JOB_DATA') {
        LOG('📦 Données d’offre reçues depuis la page (postMessage):', data.payload);
        // store on window for popup/content access
        window.__lastOfferData = data.payload;
        window.__lastOfferData.___receivedAt = Date.now();
      }
    } catch (e) {
      console.error('[content.js] message listener error', e);
    }
  });

  // ---------------------------
  // 4) Fallback: intercept fetch to capture job JSON (if page_inject not present)
  //    We'll do a light interception that records responses whose URL looks like job endpoints.
  // ---------------------------
  (function interceptFetchOnce() {
    if (window.__FANILO_FETCH_INTERCEPTED) return;
    window.__FANILO_FETCH_INTERCEPTED = true;

    try {
      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
          const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
          // heuristique : url contient "job", "jobs", "offers", "job-response" etc.
          if (url && /job|jobs|offer|offers|job-response|jobResponse/i.test(url)) {
            // clone response to read body safely
            res.clone().json().then(json => {
              LOG('💾 fetch intercepté:', url, json);
              // try to find job data inside json
              if (json && typeof json === 'object') {
                // store as last offer data
                window.__lastOfferData = json;
                window.__lastOfferData.___receivedAt = Date.now();
              }
            }).catch(()=>{ /* not json or empty */ });
          }
        } catch (e) { /* ignore errors */ }
        return res;
      };
      LOG('interceptFetch installé');
    } catch (e) {
      console.warn('[content.js] impossible d\'intercepter fetch', e);
    }
  })();

  // ---------------------------
  // 5) Offer extraction (async). Strategy:
  //    - If window.__lastOfferData exists -> use it
  //    - Else wait some time for page_inject/fetch to populate __lastOfferData
  //    - Else fallback to DOM polling / body.innerText fallback
  // ---------------------------
  async function extractOfferData() {
    LOG('Extraction offre → start');

    // 1) if already captured
    if (window.__lastOfferData && (Date.now() - (window.__lastOfferData.___receivedAt || 0)) < 1000 * 60) {
      LOG('Utilisation de __lastOfferData capturé récemment');
      return normalizeOffer(window.__lastOfferData);
    }

    // 2) wait a bit for page_inject or fetch to populate data
    const waitForOfferFromPage = (timeoutMs = 8000) => {
      return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          if (window.__lastOfferData) return resolve(window.__lastOfferData);
          if (Date.now() - start > timeoutMs) return resolve(null);
          setTimeout(check, 300);
        };
        check();
      });
    };

    const found = await waitForOfferFromPage(9000);
    if (found) {
      LOG('Données reçues via page/fetch pendant attente');
      return normalizeOffer(found);
    }

    // 3) fallback to DOM polling (longer wait)
    LOG('Fallback DOM polling (30s max)');
    const maxAttempts = 60; // 30s
    let attempt = 0;
    while (attempt < maxAttempts) {
      const profile = document.querySelector('.cmqlx, .job-description, [data-job-description], .job-desc, .offer-content');
      const exp = document.querySelector('.cmqlt, .experience-badge, .job-experience');
      const salary = document.querySelector('.cmqlaO0, .salary, .job-salary');

      // also check body text length
      const bodyText = document.body && document.body.innerText ? document.body.innerText.trim() : '';
      const hasBody = bodyText.length > 200;

      if (profile || exp || salary || hasBody) break;

      if (attempt % 6 === 0) LOG(`⏳ polling DOM... tentative ${attempt + 1}/${maxAttempts}`);
      attempt++;
      await new Promise(r => setTimeout(r, 500));
    }

    // extract from DOM:
    const offer = {
      jobTitle: textOf('h1, .job-title, .offer-title'),
      jobDescription: textOf('.cmqlx, .job-description, [data-job-description], .job-desc') || document.body.innerText.slice(0, 1500),
      profileDescription: textOf('.profileDescription, .profile-description, .profile-desc') || '',
      experience: textOf('.cmqlt, .experience-badge, .job-experience') || '',
      salary: textOf('.cmqlaO0, .salary, .job-salary') || '',
      skills: Array.from(document.querySelectorAll('.coyik, .skill-tag, .skill')).map(e => e.textContent.trim()).filter(Boolean),
      rawBodySnippet: document.body.innerText.trim().slice(0, 2000)
    };

    LOG('Offer extrait par fallback DOM:', offer);
    return normalizeOffer(offer);
  }

  // ---------------------------
  // Helper to normalize offer objects coming from different sources
  // ---------------------------
  function normalizeOffer(raw) {
    try {
      // If raw has jobResponse shape (bubble/wink), try to map common fields
      if (raw.jobTitle || raw.jobTitle === undefined) {
        // try to detect known property names
        const out = {
          id: raw.id || raw.externalId || raw.jobId || raw.job?.id || raw._id || null,
          title: raw.jobTitle || raw.jobTitle || raw.job?.jobTitle || raw.jobTitle || raw.title || raw.job?.title || raw.jobTitle,
          description: raw.jobDescription || raw.job?.jobDescription || raw.jobDescription || raw.job?.description || raw.description || raw.jobDescription,
          profileDescription: raw.profileDescription || raw.profile?.profileDescription || raw.profile || raw.profileDescription,
          experience: raw.experience || raw.job?.experience || raw.jobExperience || '',
          education: raw.education || '',
          salary: (raw.salary && typeof raw.salary === 'object') ? `${raw.salary.min || 0}-${raw.salary.max || 0} ${raw.salary.currency || ''}` : (raw.salary || ''),
          remote: raw.remote || raw.job?.remote || '',
          company: raw.company?.name || raw.company?.companyName || raw.company || '',
          contact: raw.contact || raw.company?.contact || null,
          raw // keep original for debugging
        };
        return out;
      }

      // Generic fallback mapping
      const out2 = {
        id: raw.id || raw.externalId || null,
        title: raw.jobTitle || raw.title || raw.job?.title || '',
        description: raw.jobDescription || raw.description || raw.job?.description || raw.job?.jobDescription || raw.jobDescription || '',
        profileDescription: raw.profileDescription || raw.profile_description || raw.profile || '',
        experience: raw.experience || '',
        salary: (raw.salary && typeof raw.salary === 'object') ? `${raw.salary.min || 0}-${raw.salary.max || 0} ${raw.salary.currency || ''}` : (raw.salary || ''),
        company: raw.company?.name || raw.company || '',
        raw
      };
      return out2;
    } catch (e) {
      return { title: '', description: '', raw };
    }
  }

  // ---------------------------
  // 6) Chrome message listener (popup.js will call extractCandidate/extractOffer)
  // ---------------------------
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    try {
      LOG('Message reçu from popup:', req.action);
      if (req.action === 'extractCandidate') {
        const data = extractCandidateData();
        sendResponse({ success: true, data });
        return; // sync response fine
      }

      if (req.action === 'extractOffer') {
        // async path - keep channel open
        extractOfferData()
          .then(data => sendResponse({ success: true, data }))
          .catch(err => {
            console.error('[content.js] extractOffer error', err);
            sendResponse({ success: false, error: err.message || String(err) });
          });
        return true; // important for async sendResponse
      }

      // unknown action
      sendResponse({ success: false, error: 'unknown_action' });
    } catch (e) {
      console.error('[content.js] runtime.onMessage error', e);
      sendResponse({ success: false, error: e.message });
    }
    // no return true here for sync early cases
  });

  // ---------------------------
  // 7) Small debug helper: show iframes accessible (on-demand)
  // ---------------------------
  LOG('debug: iframes count:', document.querySelectorAll('iframe').length);
  // don't spam content - you can uncomment below to log iframe contents if accessible
  /*
  [...document.querySelectorAll('iframe')].forEach((f, i) => {
    try {
      LOG('iframe', i, f.src, 'size', f.offsetWidth, f.offsetHeight, 'text:', f.contentDocument?.body?.innerText?.slice(0,200));
    } catch(e) {
      LOG('iframe', i, 'inaccessible (cross-origin)');
    }
  });
  */

})(); // end wrapper
