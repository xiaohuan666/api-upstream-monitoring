export function configureExternalLink(element, url) {
  const value = String(url ?? '').trim();
  element.textContent = value || '-';
  element.setAttribute('href', value || '#');
  element.setAttribute('target', '_blank');
  element.setAttribute('rel', 'noopener noreferrer');
}
