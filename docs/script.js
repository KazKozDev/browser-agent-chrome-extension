/* ═══════════════════════════════════════════
   BrowseAgent Landing — Script
   ═══════════════════════════════════════════ */

(function () {
    'use strict';

    // ── Nav scroll effect ──
    const nav = document.getElementById('nav');

    function handleScroll() {
        if (window.scrollY > 40) {
            nav.classList.add('nav--scrolled');
        } else {
            nav.classList.remove('nav--scrolled');
        }
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    // ── Mobile menu ──
    const burger = document.getElementById('nav-burger');
    const mobileMenu = document.getElementById('mobile-menu');

    if (burger && mobileMenu) {
        burger.addEventListener('click', () => {
            burger.classList.toggle('active');
            mobileMenu.classList.toggle('active');
        });

        mobileMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                burger.classList.remove('active');
                mobileMenu.classList.remove('active');
            });
        });
    }

    // ── Smooth scroll for anchor links ──
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const href = this.getAttribute('href');
            if (href === '#') return;
            const target = document.querySelector(href);
            if (target) {
                e.preventDefault();
                const y = target.getBoundingClientRect().top + window.scrollY - 72;
                window.scrollTo({ top: y, behavior: 'smooth' });
            }
        });
    });

    // ── Universal scroll reveal ──
    // Observes every element that already has class "reveal" in HTML
    const revealObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    revealObserver.unobserve(entry.target);
                }
            });
        },
        {
            threshold: 0.08,
            rootMargin: '0px 0px -40px 0px'
        }
    );

    // Observe all elements marked .reveal in HTML
    document.querySelectorAll('.reveal').forEach(el => {
        revealObserver.observe(el);
    });

    // Also add reveal class dynamically to individual cards/steps/rows
    // (for elements NOT already marked with .reveal in HTML)
    const dynamicRevealSelectors = [
        '.feature-card',
        '.eff-row',
        '.tool-group',
        '.integration-row',
        '.provider-row',
        '.setup-step',
        '.step',
        '.limit-item',
        '.hero__stat',
    ];

    dynamicRevealSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach((el, i) => {
            if (!el.classList.contains('reveal')) {
                el.classList.add('reveal');
                el.style.transitionDelay = `${i * 0.04}s`;
                revealObserver.observe(el);
            }
        });
    });

    // ── Active nav link highlight ──
    const sections = document.querySelectorAll('section[id], div[id]');
    const navLinks = document.querySelectorAll('.nav__link');

    const sectionObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const id = entry.target.getAttribute('id');
                    navLinks.forEach(link => {
                        link.classList.remove('active');
                        if (link.getAttribute('href') === `#${id}`) {
                            link.classList.add('active');
                        }
                    });
                }
            });
        },
        {
            rootMargin: '-30% 0px -60% 0px',
            threshold: 0
        }
    );

    sections.forEach(section => sectionObserver.observe(section));

})();
