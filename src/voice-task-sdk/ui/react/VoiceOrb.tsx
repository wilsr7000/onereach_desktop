/**
 * VoiceOrb - An animated orb component for voice input
 * 
 * Features:
 * - Firefly theme with organic, bioluminescent glow animation
 * - Classic theme with pulsing animation
 * - Volume-reactive glow effect
 * - Status indicators
 * - Click to toggle listening
 */

import React, { useMemo, useEffect, useState, useRef, type CSSProperties } from 'react'
import { useVoice } from '../../voice/hooks/useVoice'
import type { VoiceStatus } from '../../voice/types'

export type OrbTheme = 'default' | 'firefly'

export interface VoiceOrbProps {
  /** OpenAI API key */
  apiKey: string
  /** Size of the orb in pixels */
  size?: number
  /** Visual theme: 'default' (purple pulse) or 'firefly' (organic bioluminescent) */
  theme?: OrbTheme
  /** Primary color (hex or rgb) - used for default theme */
  color?: string
  /** Error color */
  errorColor?: string
  /** Show transcript overlay */
  showTranscript?: boolean
  /** Callback when transcript is received */
  onTranscript?: (transcript: string) => void
  /** Callback on error */
  onError?: (error: Error) => void
  /** Custom class name */
  className?: string
  /** Custom styles */
  style?: CSSProperties
  /** Preferred speech backend */
  preferredBackend?: 'realtime' | 'whisper'
  /** Language code */
  language?: string
  /** Disabled state */
  disabled?: boolean
}

const STATUS_LABELS: Record<VoiceStatus, string> = {
  idle: 'Click to speak',
  listening: 'Listening...',
  processing: 'Processing...',
  speaking: 'Speaking...',
  error: 'Error occurred',
}

// Firefly color palette
const FIREFLY_COLORS = {
  idle: {
    primary: '#a3e635',    // Lime green
    secondary: '#65a30d',  // Darker green
    tertiary: '#365314',   // Deep green
    glow: 'rgba(163, 230, 53,',
    innerGlow: 'rgba(101, 163, 13,',
  },
  listening: {
    primary: '#fde047',    // Yellow
    secondary: '#eab308',  // Golden
    tertiary: '#a16207',   // Amber
    glow: 'rgba(253, 224, 71,',
    innerGlow: 'rgba(234, 179, 8,',
  },
  processing: {
    primary: '#fb923c',    // Orange
    secondary: '#ea580c',  // Deep orange
    tertiary: '#9a3412',   // Burnt orange
    glow: 'rgba(251, 146, 60,',
    innerGlow: 'rgba(234, 88, 12,',
  },
  error: {
    primary: '#f87171',    // Red
    secondary: '#dc2626',  // Deep red
    tertiary: '#991b1b',   // Dark red
    glow: 'rgba(248, 113, 113,',
    innerGlow: 'rgba(220, 38, 38,',
  },
}

export function VoiceOrb({
  apiKey,
  size = 80,
  theme = 'firefly',
  color = '#6366f1',
  errorColor = '#ef4444',
  showTranscript = true,
  onTranscript,
  onError,
  className = '',
  style = {},
  preferredBackend = 'realtime',
  language = 'en',
  disabled = false,
}: VoiceOrbProps) {
  const {
    status,
    isListening,
    transcript,
    interimTranscript,
    error,
    volume,
    toggle,
  } = useVoice({
    apiKey,
    preferredBackend,
    language,
    onTranscript,
    onError,
  })

  const isError = status === 'error'
  const isProcessing = status === 'processing'
  
  // Firefly organic glow state
  const [glowIntensity, setGlowIntensity] = useState(0.4)
  const glowTargetRef = useRef(0.4)
  const animationRef = useRef<number | null>(null)

  // Get firefly colors based on state
  const fireflyColors = useMemo(() => {
    if (isError) return FIREFLY_COLORS.error
    if (isProcessing) return FIREFLY_COLORS.processing
    if (isListening) return FIREFLY_COLORS.listening
    return FIREFLY_COLORS.idle
  }, [isError, isProcessing, isListening])

  // Organic firefly glow animation
  useEffect(() => {
    if (theme !== 'firefly') return

    let currentGlow = glowIntensity
    
    const updateGlow = () => {
      // Smoothly interpolate toward target
      currentGlow += (glowTargetRef.current - currentGlow) * 0.08
      setGlowIntensity(currentGlow)
      animationRef.current = requestAnimationFrame(updateGlow)
    }

    const setRandomTarget = () => {
      if (isListening) {
        // More active, brighter glow when listening
        glowTargetRef.current = 0.8 + Math.random() * 0.6
      } else {
        // Gentle ambient glow when idle
        glowTargetRef.current = 0.3 + Math.random() * 0.3
      }
      
      // Random interval for organic feel
      const nextInterval = isListening 
        ? 300 + Math.random() * 400
        : 800 + Math.random() * 1200
      
      setTimeout(setRandomTarget, nextInterval)
    }

    animationRef.current = requestAnimationFrame(updateGlow)
    setRandomTarget()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [theme, isListening])

  // Calculate glow intensity based on volume (for default theme)
  const volumeGlow = useMemo(() => {
    if (!isListening) return 0
    return Math.min(volume * 2, 1)
  }, [isListening, volume])

  // Keyframes for animations
  const keyframesStyle = theme === 'firefly' ? `
    @keyframes fireflyFloat {
      0%, 100% { transform: translate(0, 0) rotate(0deg); }
      25% { transform: translate(2px, -3px) rotate(1deg); }
      50% { transform: translate(-1px, -1px) rotate(-1deg); }
      75% { transform: translate(-2px, -2px) rotate(0.5deg); }
    }
    @keyframes fireflyBreathe {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.15); }
    }
    @keyframes fireflyRing {
      0% { transform: scale(1); opacity: 0.6; }
      100% { transform: scale(2); opacity: 0; }
    }
    @keyframes fireflyAura {
      0%, 100% { transform: scale(1.2); opacity: 0.3; }
      50% { transform: scale(1.5); opacity: 0.6; }
    }
  ` : `
    @keyframes voiceOrbPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    @keyframes voiceOrbRing {
      0% { transform: scale(1); opacity: 1; }
      100% { transform: scale(1.5); opacity: 0; }
    }
  `

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    ...style,
  }

  const orbContainerStyle: CSSProperties = {
    position: 'relative',
    width: size,
    height: size,
  }

  // Firefly orb style
  const fireflyOrbStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    background: `radial-gradient(circle at 40% 40%, ${fireflyColors.primary}, ${fireflyColors.secondary} 60%, ${fireflyColors.tertiary})`,
    boxShadow: `
      0 0 ${15 * glowIntensity}px ${5 * glowIntensity}px ${fireflyColors.glow} 0.6),
      0 0 ${30 * glowIntensity}px ${10 * glowIntensity}px ${fireflyColors.glow} 0.3),
      0 0 ${50 * glowIntensity}px ${20 * glowIntensity}px ${fireflyColors.innerGlow} 0.2),
      inset 0 0 15px rgba(255, 255, 255, ${0.15 + glowIntensity * 0.1})
    `,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 0.3s ease',
    animation: isListening 
      ? 'fireflyFloat 4s ease-in-out infinite, fireflyBreathe 2s ease-in-out infinite'
      : 'fireflyFloat 6s ease-in-out infinite',
    opacity: disabled ? 0.5 : 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  }

  // Default orb style
  const defaultOrbStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    background: `radial-gradient(circle at 30% 30%, ${isError ? errorColor : color}dd, ${isError ? errorColor : color}88)`,
    boxShadow: isListening
      ? `0 0 ${20 + volumeGlow * 40}px ${10 + volumeGlow * 20}px ${color}66,
         0 0 ${40 + volumeGlow * 60}px ${20 + volumeGlow * 30}px ${color}33,
         inset 0 0 20px rgba(255,255,255,0.2)`
      : `0 4px 20px ${color}33, inset 0 0 20px rgba(255,255,255,0.1)`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'box-shadow 0.15s ease, transform 0.2s ease',
    animation: isListening ? 'voiceOrbPulse 2s ease-in-out infinite' : 'none',
    opacity: disabled ? 0.5 : 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  const orbStyle = theme === 'firefly' ? fireflyOrbStyle : defaultOrbStyle

  // Firefly ring style
  const fireflyRingStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: size,
    height: size,
    borderRadius: '50%',
    border: `1px solid ${fireflyColors.glow} 0.5)`,
    animation: isListening ? 'fireflyRing 3s ease-out infinite' : 'none',
    pointerEvents: 'none',
  }

  // Default ring style
  const defaultRingStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: size,
    height: size,
    borderRadius: '50%',
    border: `2px solid ${isError ? errorColor : color}`,
    animation: isListening ? 'voiceOrbRing 1.5s ease-out infinite' : 'none',
    pointerEvents: 'none',
  }

  const ringStyle = theme === 'firefly' ? fireflyRingStyle : defaultRingStyle

  // Secondary aura for firefly theme
  const auraStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: size,
    height: size,
    borderRadius: '50%',
    background: `radial-gradient(circle, ${fireflyColors.glow} 0.15) 0%, transparent 70%)`,
    animation: isListening ? 'fireflyAura 2s ease-in-out infinite' : 'none',
    pointerEvents: 'none',
  }

  // Highlight overlay for firefly
  const highlightStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    borderRadius: '50%',
    background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.4) 0%, transparent 50%)',
    pointerEvents: 'none',
  }

  const iconStyle: CSSProperties = theme === 'firefly' ? {
    width: size * 0.35,
    height: size * 0.35,
    fill: 'rgba(0, 0, 0, 0.6)',
    filter: 'drop-shadow(0 0 2px rgba(255, 255, 255, 0.5))',
  } : {
    width: size * 0.4,
    height: size * 0.4,
    fill: 'white',
    opacity: 0.9,
  }

  const statusStyle: CSSProperties = {
    fontSize: '14px',
    color: isError ? errorColor : '#6b7280',
    fontWeight: 500,
  }

  const transcriptStyle: CSSProperties = {
    maxWidth: '300px',
    padding: '12px 16px',
    background: 'rgba(0, 0, 0, 0.05)',
    borderRadius: '12px',
    fontSize: '14px',
    color: '#374151',
    lineHeight: 1.5,
    textAlign: 'center',
    minHeight: '24px',
  }

  const interimStyle: CSSProperties = {
    ...transcriptStyle,
    color: '#9ca3af',
    fontStyle: 'italic',
  }

  const handleClick = () => {
    if (disabled) return
    toggle()
  }

  const MicIcon = () => (
    <svg viewBox="0 0 24 24" style={iconStyle}>
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
    </svg>
  )

  const StopIcon = () => (
    <svg viewBox="0 0 24 24" style={iconStyle}>
      <rect x="6" y="6" width="12" height="12" rx="2"/>
    </svg>
  )

  return (
    <div className={className} style={containerStyle}>
      <style>{keyframesStyle}</style>
      
      <div style={orbContainerStyle}>
        {isListening && <div style={ringStyle} />}
        {theme === 'firefly' && isListening && <div style={auraStyle} />}
        <div 
          style={orbStyle}
          onClick={handleClick}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label={isListening ? 'Stop listening' : 'Start listening'}
          onKeyDown={(e) => e.key === 'Enter' && handleClick()}
        >
          {theme === 'firefly' && <div style={highlightStyle} />}
          {isListening ? <StopIcon /> : <MicIcon />}
        </div>
      </div>

      <div style={statusStyle}>
        {error || STATUS_LABELS[status]}
      </div>

      {showTranscript && (
        <>
          {interimTranscript && (
            <div style={interimStyle}>{interimTranscript}</div>
          )}
          {transcript && !interimTranscript && (
            <div style={transcriptStyle}>{transcript}</div>
          )}
        </>
      )}
    </div>
  )
}

export default VoiceOrb
