
    const chapters = [
      [0, 'Meet Maya and Noor'], [14.566667, 'What Canary does'], [29.266667, 'Protect the file'],
      [43.566667, 'Early recovery is blocked'], [53.533333, 'Maya checks in'], [64.9, 'Cancel the handoff'],
      [77.266667, 'Miss a check-in'], [88.433333, 'Return during grace'], [100.433333, 'Stale scans: release waits'],
      [110.6, 'Two shares: not enough'], [120.933333, 'Restore the third keeper'], [131.233333, 'Try the wrong recipient key'],
      [141.166667, 'Recover and download'], [155.666667, 'Recorded native testnet proof'], [175.766667, 'Try the example yourself']
    ];
    const video = document.getElementById('canary-video');
    const list = document.getElementById('chapters');
    const message = document.getElementById('player-message');
    const mode = document.getElementById('film-mode');
    const buttons = chapters.map(([start, label]) => {
      const button = document.createElement('button');
      button.className = 'chapter'; button.type = 'button';
      const time = document.createElement('time');
      time.textContent = Math.floor(start / 60) + ':' + String(Math.floor(start % 60)).padStart(2, '0');
      const text = document.createElement('span'); text.textContent = label;
      button.append(time, text); button.setAttribute('aria-label', `Play ${label}, ${time.textContent}`);
      button.addEventListener('click', async () => {
        message.textContent = '';
        try {
          if (video.readyState === 0) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => { cleanup(); reject(new Error('metadata-timeout')); }, 15000);
              const loaded = () => { cleanup(); resolve(); };
              const failed = () => { cleanup(); reject(new Error('media-load')); };
              const cleanup = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', loaded); video.removeEventListener('error', failed); };
              video.addEventListener('loadedmetadata', loaded, { once: true }); video.addEventListener('error', failed, { once: true });
              video.load();
            });
          }
          video.currentTime = start;
          await video.play();
        } catch {
          message.textContent = 'Playback could not start here. Press Play in the video controls, or use Download MP4.';
        }
      });
      list.appendChild(button); return button;
    });
    let lastChapter = -1;
    function updateChapter() {
      let current = 0;
      chapters.forEach(([start], index) => { if (video.currentTime >= start) current = index; });
      if (current !== lastChapter) {
        buttons.forEach((button, index) => { button.setAttribute('aria-current', index === current ? 'true' : 'false'); });
        lastChapter = current;
      }
      const t = video.currentTime;
      const simulated = t >= 29.266667 && t < 155.666667;
      mode.classList.toggle('simulation', simulated);
      mode.textContent = simulated ? 'BROWSER SIMULATION / CAPTURED ACTIONS, EDITED FOR TIME' : t >= 155.666667 && t < 175.766667 ? 'NATIVE TESTNET / RECORDED VERIFICATION EVIDENCE' : 'MAYA & NOOR / FICTIONAL EXAMPLE';
    }
    video.addEventListener('timeupdate', updateChapter);
    video.addEventListener('loadedmetadata', updateChapter);
    const showMediaError = () => { message.textContent = 'The embedded video could not load. The Download MP4 link opens the same film on GitHub.'; };
    video.addEventListener('error', showMediaError);
    video.querySelector('source').addEventListener('error', showMediaError);
    updateChapter();
  