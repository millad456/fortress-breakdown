/**
 * Fortress registry. Each entry lazy-loads its module (content + 3D builder).
 * To add a fortress: create src/fortresses/<id>/ with content.js and index.js, then register it here.
 */
export const FORTRESSES = [
  {
    id: 'dubrovnik',
    name: 'Dubrovnik',
    country: 'Croatia',
    era: '8th – 17th century',
    tagline: 'The city that was never taken by force',
    hero: 'City walls of Dubrovnik 01.jpg',
    heroCredit: 'Bernard Gagnon · CC BY-SA 4.0',
    status: 'live',
    load: () => import('./dubrovnik/index.js'),
  },
  { id: 'carcassonne', name: 'Carcassonne', country: 'France', era: '3rd – 13th century', tagline: 'Fifty-two towers and a double ring', status: 'soon' },
  { id: 'krak', name: 'Krak des Chevaliers', country: 'Syria', era: '12th – 13th century', tagline: 'The Crusaders’ concentric masterpiece', status: 'soon' },
  { id: 'constantinople', name: 'Theodosian Walls', country: 'Türkiye', era: '5th century', tagline: 'A thousand years of holding the line', status: 'soon' },
];

export function commonsUrl(file, width = 1400) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
}
export function commonsPage(file) {
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, '_'))}`;
}
