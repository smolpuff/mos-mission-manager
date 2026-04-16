/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.jsx",
    "./index.html",
    "./renderer/src/components/**/*.{html,js,ts,jsx,tsx,vue,svelte}",
    "./js/**/*.js",
    "./src/*.{html,js,ts,jsx,tsx,vue,svelte}",
  ],
};
