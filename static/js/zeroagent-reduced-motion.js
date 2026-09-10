/*
 * The hero video is the page's only unprompted motion. Someone who has
 * asked their system for reduced motion gets the poster instead.
 */
(function () {
	'use strict';
	if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	var video = document.querySelector('.za-hero-window video');
	if (!video) return;
	video.removeAttribute('autoplay');
	video.pause();
	video.setAttribute('controls', '');
})();
