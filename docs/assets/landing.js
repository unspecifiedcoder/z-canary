
    const chapters = [
      [0, 'Meet Maya and Noor'], [9.773, 'The third option'], [18.487, 'Why Zcash'],
      [30.741, 'Create a handoff'], [44.392, 'Register and test early access'], [50.747, 'Maya checks in'],
      [55.684, 'Inspect the real counterpart'], [69.036, 'Controlled recovery'], [78.645, 'Verify testnet receipts']
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
      const simulated = t >= 30.741 && t < 78.645;
      mode.classList.toggle('simulation', simulated);
      mode.textContent = simulated ? 'BROWSER LAB / CAPTURED ACTIONS, EDITED FOR TIME' : t >= 78.645 ? 'ZCASH TESTNET / RECORDED VERIFICATION EVIDENCE' : 'MAYA & NOOR / FICTIONAL EXAMPLE';
    }
    video.addEventListener('timeupdate', updateChapter);
    video.addEventListener('loadedmetadata', updateChapter);
    const showMediaError = () => { message.textContent = 'The embedded video could not load. The Download MP4 link opens the same film on GitHub.'; };
    video.addEventListener('error', showMediaError);
    video.querySelector('source').addEventListener('error', showMediaError);
    updateChapter();

