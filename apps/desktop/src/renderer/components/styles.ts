import type { CSSProperties } from 'react'

/**
 * Legacy inline-style tokens. New pages use `styles.css`; this file stays for the
 * remaining form/console panels so they share the same palette and radii.
 */
export const colors = {
  bg: '#f8f8f8',
  panel: '#ffffff',
  border: '#e3e3e3',
  text: '#080808',
  muted: '#666666',
  green: '#3b8a4f',
  red: '#b3261e',
  amber: '#c79a1c',
  blue: '#2f6fdb',
  subtle: '#eeeeee',
}

export const panelStyle: CSSProperties = {
  background: colors.panel,
  border: `1px solid ${colors.subtle}`,
  borderRadius: 12,
  padding: 16,
}

export const sectionTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: colors.muted,
  margin: '0 0 10px',
}

export const buttonStyle: CSSProperties = {
  fontSize: 12.5,
  padding: '5px 12px',
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  background: colors.panel,
  color: colors.text,
  cursor: 'pointer',
}

export const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: '#c2542d',
  borderColor: '#c2542d',
  color: '#ffffff',
  fontWeight: 600,
}

export const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: colors.red,
  borderColor: 'rgb(179 38 30 / 28%)',
  background: 'transparent',
}

export const inputStyle: CSSProperties = {
  fontSize: 12.5,
  padding: '6px 9px',
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  background: colors.panel,
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  color: colors.text,
}

export const labelStyle: CSSProperties = {
  fontSize: 11,
  color: colors.muted,
  display: 'block',
  marginBottom: 4,
}
