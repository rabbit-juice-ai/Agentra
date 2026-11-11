import { useEffect, useState } from 'react'

export type UserProfile = {
  name: string
  avatar: string
}

export const DEFAULT_USER_PROFILE: UserProfile = {
  name: '老板',
  avatar: '👤',
}

const STORAGE_KEY = 'agentra.userProfile'
const CHANGE_EVENT = 'agentra:user-profile-changed'

export function loadUserProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_USER_PROFILE }
    const parsed = JSON.parse(raw) as Partial<UserProfile>
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : '老板',
      avatar:
        typeof parsed.avatar === 'string' && parsed.avatar.trim()
          ? parsed.avatar
          : DEFAULT_USER_PROFILE.avatar,
    }
  } catch {
    return { ...DEFAULT_USER_PROFILE }
  }
}

export function saveUserProfile(profile: UserProfile): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      name: profile.name.trim() || DEFAULT_USER_PROFILE.name,
      avatar: profile.avatar.trim() || DEFAULT_USER_PROFILE.avatar,
    }),
  )
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

export function useUserProfile(): {
  profile: UserProfile
  updateProfile: (profile: UserProfile) => void
} {
  const [profile, setProfile] = useState<UserProfile>(() => loadUserProfile())

  useEffect(() => {
    const sync = (): void => setProfile(loadUserProfile())
    window.addEventListener(CHANGE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  return {
    profile,
    updateProfile: (next) => {
      saveUserProfile(next)
      setProfile(loadUserProfile())
    },
  }
}
