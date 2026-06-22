/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                primary: {
                    DEFAULT: '#141414',
                    foreground: '#ffffff',
                },
                accent: {
                    DEFAULT: '#fc3000',
                    foreground: '#ffffff',
                },
            },
            fontFamily: {
                manrope: ['Manrope', 'sans-serif'],
            },
        },
    },
    plugins: [],
}
