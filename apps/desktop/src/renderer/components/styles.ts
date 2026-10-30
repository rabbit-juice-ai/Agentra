import type { CSSProperties } from 'react'

export const colors = {
  bg: '#f6f8fa',
  panel: '#ffffff',
  border: '#d0d7de',
  text: '#1f2328',
  muted: '#57606a',
  green: '#1a7f37',
  red: '#cf222e',
  amber: '#9a6700',
  blue: '#0969da',
  subtle: '#eaeef2',
}

export const panelStyle: CSSProperties = {
  background: colors.panel,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: 16,
}

export const sectionTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: colors.muted,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  margin: '0 0 10px',
}

export const buttonStyle: CSSProperties = {
  fontSize: 13,
  padding: '5px 12px',
  borderRadius: 6,
  border: `1px solid ${colors.border}`,
  background: colors.panel,
  color: colors.text,
  cursor: 'pointer',
}

export const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: colors.green,
  borderColor: colors.green,
  color: '#ffffff',
}

export const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: colors.red,
  borderColor: '#ff8182',
}

export const inputStyle: CSSProperties = {
  fontSize: 13,
  padding: '6px 8px',
  borderRadius: 6,
  border: `1px solid ${colors.border}`,
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
}

export const labelStyle: CSSProperties = {
  fontSize: 12,
  color: colors.muted,
  display: 'block',
  marginBottom: 4,
}
