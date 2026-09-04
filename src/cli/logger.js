// Cyberpunk terminal colors and formatting
const ESC = "\x1b[";
export const colors = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  
  // Neon Greens
  neonGreen: `${ESC}38;5;48m`,
  brightGreen: `${ESC}38;5;82m`,
  matrixGreen: `${ESC}38;5;40m`,
  darkGreen: `${ESC}38;5;28m`,
  
  // Dark/Carbon Backgrounds & Text
  carbon: `${ESC}38;5;236m`,
  muted: `${ESC}38;5;244m`,
  white: `${ESC}38;5;255m`,
  
  // Status Colors
  cyan: `${ESC}38;5;51m`,
  yellow: `${ESC}38;5;220m`,
  red: `${ESC}38;5;196m`,
  
  bgBlack: `${ESC}48;5;232m`,
  bgDarkGreen: `${ESC}48;5;22m`
};

export const logger = {
  banner() {
    console.log(`
${colors.neonGreen}   ▄████████  ▄███████▄ ▄██   ▄      ▄▄▄▄███▄▄▄▄      ▄████████     ███        ▄████████ 
  ███    ███ ███    ███ ███   ██▄  ▄██▀▀▀███▀▀▀██▄   ███    ███ ▀█████████▄   ███    ███ 
  ███    █▀  ▀▀     ███ ███▄▄▄███  ███   ███   ███   ███    █▀     ▀███▀▀██   ███    ███ 
 ▄███▄▄▄            ███ ▀▀▀▀▀▀███  ███   ███   ███  ▄███▄▄▄         ███   ▀   ███    ███ 
▀▀███▀▀▀          ▄██▀  ▄██   ███  ███   ███   ███ ▀▀███▀▀▀         ███     ▀███████████ 
  ███    █▄      ▄██    ███   ███  ███   ███   ███   ███    █▄      ███       ███    ███ 
  ███    ███    ███▄▄▄▄ ███   ███  ███   ███   ███   ███    ███     ███       ███    ███ 
  ██████████    ███████  ▀█████▀    ▀█   ███   █▀    ██████████    ▄████▀     ███    █▀  
${colors.dim}       [ Meta AI Image-to-Video Bridge • CLI & Chrome Extension Protocol ]${colors.reset}
`);
  },

  success(msg) {
    console.log(`${colors.brightGreen}✔ ${colors.white}${msg}${colors.reset}`);
  },

  info(msg) {
    console.log(`${colors.cyan}ℹ ${colors.white}${msg}${colors.reset}`);
  },

  warn(msg) {
    console.log(`${colors.yellow}⚠ ${colors.white}${msg}${colors.reset}`);
  },

  error(msg) {
    console.log(`${colors.red}✖ ${colors.white}${msg}${colors.reset}`);
  },

  box(title, lines) {
    const width = 64;
    const border = "─".repeat(width);
    console.log(`${colors.matrixGreen}┌${border}┐${colors.reset}`);
    console.log(`${colors.matrixGreen}│ ${colors.bold}${colors.neonGreen}${title.padEnd(width - 2)}${colors.reset}${colors.matrixGreen} │${colors.reset}`);
    console.log(`${colors.matrixGreen}├${border}┤${colors.reset}`);
    for (const line of lines) {
      console.log(`${colors.matrixGreen}│ ${colors.reset}${line.padEnd(width - 2)}${colors.matrixGreen} │${colors.reset}`);
    }
    console.log(`${colors.matrixGreen}└${border}┘${colors.reset}`);
  }
};
