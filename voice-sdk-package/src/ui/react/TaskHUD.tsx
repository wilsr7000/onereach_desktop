/**
 * TaskHUD - Heads-up display for task status
 * 
 * Shows current and recent tasks with their status in a floating overlay.
 */

import { useState, useEffect, type CSSProperties } from 'react'
import type { Task, TaskStatus } from '../../core/types'
import type { VoiceTaskSDK } from '../../createSDK'

export interface TaskHUDProps {
  /** SDK instance */
  sdk: VoiceTaskSDK
  /** Position on screen */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  /** Maximum tasks to show */
  maxTasks?: number
  /** Auto-hide completed tasks after ms (0 to disable) */
  autoHideDelay?: number
  /** Custom class name */
  className?: string
  /** Custom styles */
  style?: CSSProperties
  /** Compact mode */
  compact?: boolean
}

const STATUS_CONFIG: Record<TaskStatus, { color: string; icon: string; label: string }> = {
  pending: { color: '#f59e0b', icon: '⏳', label: 'Pending' },
  running: { color: '#3b82f6', icon: '▶️', label: 'Running' },
  completed: { color: '#10b981', icon: '✓', label: 'Done' },
  failed: { color: '#ef4444', icon: '✗', label: 'Failed' },
  cancelled: { color: '#6b7280', icon: '⊘', label: 'Cancelled' },
  deadletter: { color: '#991b1b', icon: '☠', label: 'Dead' },
}

interface TaskWithTimestamp extends Task {
  displayUntil?: number
}

export function TaskHUD({
  sdk,
  position = 'top-right',
  maxTasks = 5,
  autoHideDelay = 5000,
  className = '',
  style = {},
  compact = false,
}: TaskHUDProps) {
  const [tasks, setTasks] = useState<TaskWithTimestamp[]>([])

  useEffect(() => {
    // Subscribe to task events
    const unsubscribers: (() => void)[] = []

    const addTask = (task: Task) => {
      setTasks(prev => {
        const existing = prev.find(t => t.id === task.id)
        if (existing) {
          return prev.map(t => t.id === task.id ? { ...task, displayUntil: existing.displayUntil } : t)
        }
        return [task, ...prev].slice(0, maxTasks * 2) // Keep extra for filtering
      })
    }

    const updateTask = (task: Task) => {
      setTasks(prev => prev.map(t => {
        if (t.id === task.id) {
          const displayUntil = ['completed', 'failed', 'cancelled'].includes(task.status) && autoHideDelay > 0
            ? Date.now() + autoHideDelay
            : undefined
          return { ...task, displayUntil }
        }
        return t
      }))
    }

    unsubscribers.push(sdk.on('queued', (data) => addTask(data as Task)))
    unsubscribers.push(sdk.on('started', (data) => updateTask(data as Task)))
    unsubscribers.push(sdk.on('completed', (data) => updateTask((data as { task: Task }).task)))
    unsubscribers.push(sdk.on('failed', (data) => updateTask((data as { task: Task }).task)))
    unsubscribers.push(sdk.on('cancelled', (data) => updateTask(data as Task)))

    // Cleanup timer for auto-hide
    const cleanupInterval = setInterval(() => {
      const now = Date.now()
      setTasks(prev => prev.filter(t => !t.displayUntil || t.displayUntil > now))
    }, 1000)

    return () => {
      unsubscribers.forEach(unsub => unsub())
      clearInterval(cleanupInterval)
    }
  }, [sdk, maxTasks, autoHideDelay])

  const visibleTasks = tasks.slice(0, maxTasks)

  if (visibleTasks.length === 0) return null

  const positionStyles: Record<string, CSSProperties> = {
    'top-left': { top: 16, left: 16 },
    'top-right': { top: 16, right: 16 },
    'bottom-left': { bottom: 16, left: 16 },
    'bottom-right': { bottom: 16, right: 16 },
  }

  const containerStyle: CSSProperties = {
    position: 'fixed',
    ...positionStyles[position],
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: compact ? 4 : 8,
    maxWidth: compact ? 280 : 320,
    pointerEvents: 'none',
    ...style,
  }

  const taskStyle: CSSProperties = {
    background: 'white',
    borderRadius: compact ? 8 : 12,
    padding: compact ? '8px 12px' : '12px 16px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05)',
    display: 'flex',
    alignItems: 'center',
    gap: compact ? 8 : 12,
    animation: 'taskSlideIn 0.3s ease',
    pointerEvents: 'auto',
  }

  const keyframes = `
    @keyframes taskSlideIn {
      from {
        opacity: 0;
        transform: translateX(${position.includes('right') ? '20px' : '-20px'});
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
  `

  return (
    <div className={className} style={containerStyle}>
      <style>{keyframes}</style>
      {visibleTasks.map(task => {
        const config = STATUS_CONFIG[task.status]
        return (
          <div key={task.id} style={taskStyle}>
            <div style={{
              width: compact ? 24 : 32,
              height: compact ? 24 : 32,
              borderRadius: '50%',
              background: `${config.color}20`,
              color: config.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: compact ? 12 : 14,
              flexShrink: 0,
            }}>
              {config.icon}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: compact ? 12 : 14,
                fontWeight: 500,
                color: '#1f2937',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {task.action.replace(/_/g, ' ')}
              </div>
              {!compact && (
                <div style={{
                  fontSize: 12,
                  color: '#6b7280',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {task.content}
                </div>
              )}
            </div>
            <div style={{
              fontSize: compact ? 10 : 11,
              fontWeight: 600,
              color: config.color,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}>
              {config.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default TaskHUD
