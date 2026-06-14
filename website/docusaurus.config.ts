import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Covara",
  tagline: "Your Drizzle schema is already a backend",
  favicon: "img/favicon.svg",

  url: "https://kahveciderin.github.io",
  baseUrl: "/covara/",

  organizationName: "kahveciderin",
  projectName: "covara",
  trailingSlash: false,

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",

  markdown: {
    mermaid: true,
    // Treat .md as CommonMark (not MDX), so prose tokens like `<resource>` and
    // `{ active }` in the contract specs don't trip the MDX parser.
    format: "detect",
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  themes: ["@docusaurus/theme-mermaid"],

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl:
            "https://github.com/kahveciderin/covara/tree/master/website/",
          showLastUpdateTime: true,
          showLastUpdateAuthor: true,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/logo.svg",
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "Covara",
      logo: {
        alt: "Covara",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          to: "/quick-start",
          label: "Quick Start",
          position: "left",
        },
        {
          href: "https://github.com/kahveciderin/covara",
          label: "GitHub",
          position: "right",
        },
        {
          type: "html",
          position: "right",
          value:
            '<a class="navbar__item navbar__link" href="https://www.npmjs.com/package/covara">npm</a>',
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Introduction", to: "/" },
            { label: "Quick Start", to: "/quick-start" },
            { label: "Resources", to: "/core/resources-and-app" },
            { label: "Client Library", to: "/client/overview" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "Filtering", to: "/core/filtering" },
            { label: "Deployment", to: "/deployment/node" },
            { label: "Contracts", to: "/contracts/overview" },
            { label: "Error Handling", to: "/tooling/error-handling" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "GitHub", href: "https://github.com/kahveciderin/covara" },
            { label: "npm", href: "https://www.npmjs.com/package/covara" },
            { label: "Hono", href: "https://hono.dev" },
            { label: "Drizzle ORM", href: "https://orm.drizzle.team" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Covara. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "toml", "sql", "diff"],
    },
    mermaid: {
      theme: { light: "neutral", dark: "dark" },
    },
    // To enable search, sign up for Algolia DocSearch and uncomment:
    // algolia: {
    //   appId: "YOUR_APP_ID",
    //   apiKey: "YOUR_SEARCH_API_KEY",
    //   indexName: "covara",
    // },
  } satisfies Preset.ThemeConfig,

  plugins: [
    [
      "docusaurus-plugin-llms",
      {
        addMdExtension: true,
        generateMarkdownFiles: true,
      },
    ],
  ],
};

export default config;
