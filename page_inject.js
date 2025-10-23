(function() {
  console.log("🔍 Script injecté dans la page Wink.");

  // Vérifier si jobResponse ou Nuxt est dispo
  const tryGetJobData = () => {
    const job = window.jobResponse 
      || window.__NUXT__?.data?.[0]?.job 
      || null;

    if (job) {
      console.log("✅ Job détecté:", job);
      window.postMessage({ type: "WINK_JOB_DATA", payload: job }, "*");
      return true;
    }
    return false;
  };

  // Attendre que la page charge (Nuxt)
  let tries = 0;
  const maxTries = 20;
  const interval = setInterval(() => {
    if (tryGetJobData()) {
      clearInterval(interval);
    } else if (++tries >= maxTries) {
      console.warn("❌ Impossible de trouver jobResponse");
      clearInterval(interval);
    }
  }, 500);
})();
