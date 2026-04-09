(function() {
  'use strict';

  // ========================================
  // NAV: scroll detection
  // ========================================
  var nav = document.getElementById('nav');
  window.addEventListener('scroll', function() {
    if (window.scrollY > 10) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  }, { passive: true });

  // ========================================
  // COPY: clipboard
  // ========================================
  var installCmd = 'git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup';

  function copyInstall(btn) {
    navigator.clipboard.writeText(installCmd).then(function() {
      var original = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.background = '#22C55E';
      setTimeout(function() {
        btn.textContent = original;
        btn.style.background = '';
      }, 2000);
    }).catch(function() {
      btn.textContent = 'Select text above to copy';
      setTimeout(function() {
        btn.textContent = 'Copy';
      }, 3000);
    });
  }

  document.getElementById('copy-hero').addEventListener('click', function() { copyInstall(this); });
  document.getElementById('copy-cta').addEventListener('click', function() { copyInstall(this); });

  // ========================================
  // TERMINAL: typewriter animation
  // ========================================
  var terminalDemo = document.getElementById('terminal-demo');
  var lines = document.querySelectorAll('.terminal-line');
  var animated = false;

  // Respect prefers-reduced-motion
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) {
    // Show all lines immediately
    for (var i = 0; i < lines.length; i++) {
      lines[i].classList.add('visible');
    }
    animated = true;
  } else if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting && !animated) {
        animated = true;
        animateTerminal();
        observer.disconnect();
      }
    }, { threshold: 0.3 });

    observer.observe(terminalDemo);
  } else {
    // Fallback: show all lines
    for (var j = 0; j < lines.length; j++) {
      lines[j].classList.add('visible');
    }
  }

  function animateTerminal() {
    var delay = 0;
    var stepsData = [
      { delay: 400 },
      { delay: 800 },
      { delay: 800 },
      { delay: 600 },
      { delay: 600 }
    ];

    for (var k = 0; k < lines.length; k++) {
      (function(line, d) {
        setTimeout(function() {
          line.classList.add('visible');
        }, d);
      })(lines[k], delay);
      delay += stepsData[k] ? stepsData[k].delay : 500;
    }
  }

  // ========================================
  // DETAILS: update summary text on toggle
  // ========================================
  var details = document.querySelector('.skills-expand');
  if (details) {
    details.addEventListener('toggle', function() {
      var summary = details.querySelector('summary');
      if (details.open) {
        summary.textContent = 'Hide skills \u2191';
      } else {
        summary.textContent = 'See all 23 skills \u2193';
      }
    });
  }
})();
