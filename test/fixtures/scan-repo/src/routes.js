export const routes = [
  { path: '/', load: () => import('./Card.jsx') },
  { path: '/about', load: () => import('./About.jsx') },
];
