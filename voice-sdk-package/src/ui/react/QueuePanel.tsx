/**
 * QueuePanel - Visual queue management panel
 * 
 * Shows all queues with their tasks, stats, and controls.
 */

import React, { useState, useEffect, type CSSProperties } from 'react'
import type { Queue, QueueStats, Task } from '../../core/types'
import type { VoiceTaskSDK } from '../../createSDK'

export interface QueuePanelProps {
  /** SDK instance */
  sdk: VoiceTaskSDK
  /** Show queue controls (pause/resume/clear) */
  showControls?: boolean
  /** Custom class name */
  className?: string
  /** Custom styles */
  style?: CSSProperties
  /** Expanded by default */
  defaultExpanded?: boolean
  /** Theme */
  theme?: 'light' | 'dark'
}

interface QueueData {
  queue: Queue
  stats: QueueStats
  tasks: Task[]
}

export function QueuePanel({
  sdk,
  showControls = true,
  className = '',
  style = {},
  defaultExpanded = true,
  theme = 'light',
}: QueuePanelProps) {
  const [queues, setQueues] = useState<QueueData[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [panelExpanded, setPanelExpanded] = useState(defaultExpanded)

  useEffect(() => {
    const updateQueues = () => {
      const queueList = sdk.queues.list()
      const data: QueueData[] = queueList.map(queue => ({
        queue,
        stats: sdk.queues.getStats(queue.name) || { pending: 0, running: 0, completed: 0, failed: 0 },
        tasks: sdk.tasks.list(queue.name),
      }))
      setQueues(data)
    }

    updateQueues()

    // Subscribe to events
    const unsubscribers = [
      sdk.on('queued', updateQueues),
      sdk.on('started', updateQueues),
      sdk.on('completed', updateQueues),
      sdk.on('failed', updateQueues),
      sdk.on('queue:created', updateQueues),
      sdk.on('queue:paused', updateQueues),
      sdk.on('queue:resumed', updateQueues),
    ]

    // Periodic update for stats
    const interval = setInterval(updateQueues, 2000)

    return () => {
      unsubscribers.forEach(unsub => unsub())
      clearInterval(interval)
    }
  }, [sdk])

  const isDark = theme === 'dark'

  const colors = {
    bg: isDark ? '#1f2937' : '#ffffff',
    bgSecondary: isDark ? '#374151' : '#f9fafb',
    text: isDark ? '#f9fafb' : '#1f2937',
    textSecondary: isDark ? '#9ca3af' : '#6b7280',
    border: isDark ? '#4b5563' : '#e5e7eb',
    primary: '#6366f1',
    success: '#10b981',
    warning: '#f59e0b',
    danger: '#ef4444',
  }

  const panelStyle: CSSProperties = {
    background: colors.bg,
    borderRadius: 16,
    boxShadow: isDark 
      ? '0 4px 20px rgba(0, 0, 0, 0.4)'
      : '0 4px 20px rgba(0, 0, 0, 0.1)',
    border: `1px solid ${colors.border}`,
    overflow: 'hidden',
    minWidth: 320,
    ...style,
  }

  const headerStyle: CSSProperties = {
    padding: '16px 20px',
    borderBottom: `1px solid ${colors.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
    userSelect: 'none',
  }

  const titleStyle: CSSProperties = {
    fontSize: 16,
    fontWeight: 600,
    color: colors.text,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  }

  const toggleExpanded = (queueName: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(queueName)) {
        next.delete(queueName)
      } else {
        next.add(queueName)
      }
      return next
    })
  }

  const handlePause = (name: string) => {
    sdk.queues.pause(name)
  }

  const handleResume = (name: string) => {
    sdk.queues.resume(name)
  }

  const handleClear = (name: string) => {
    sdk.queues.clear(name)
  }

  return (
    <div className={className} style={panelStyle}>
      <div style={headerStyle} onClick={() => setPanelExpanded(p => !p)}>
        <div style={titleStyle}>
          <span>📋</span>
          <span>Queues</span>
          <span style={{
            background: colors.primary,
            color: 'white',
            borderRadius: 12,
            padding: '2px 8px',
            fontSize: 12,
            fontWeight: 500,
          }}>
            {queues.length}
          </span>
        </div>
        <span style={{
          color: colors.textSecondary,
          transform: panelExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s',
        }}>
          ▼
        </span>
      </div>

      {panelExpanded && (
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {queues.length === 0 ? (
            <div style={{
              padding: 24,
              textAlign: 'center',
              color: colors.textSecondary,
              fontSize: 14,
            }}>
              No queues created yet
            </div>
          ) : (
            queues.map(({ queue, stats, tasks }) => (
              <div key={queue.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                {/* Queue Header */}
                <div
                  style={{
                    padding: '12px 20px',
                    background: colors.bgSecondary,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    cursor: 'pointer',
                  }}
                  onClick={() => toggleExpanded(queue.name)}
                >
                  <span style={{
                    transform: expanded.has(queue.name) ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s',
                    color: colors.textSecondary,
                  }}>
                    ▶
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: colors.text,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}>
                      {queue.name}
                      {queue.paused && (
                        <span style={{
                          background: colors.warning,
                          color: 'white',
                          borderRadius: 4,
                          padding: '1px 6px',
                          fontSize: 10,
                          fontWeight: 500,
                        }}>
                          PAUSED
                        </span>
                      )}
                    </div>
                    <div style={{
                      fontSize: 12,
                      color: colors.textSecondary,
                      marginTop: 2,
                    }}>
                      {stats.running}/{queue.concurrency} running • {stats.pending} pending
                    </div>
                  </div>
                  
                  {/* Stats badges */}
                  <div style={{ display: 'flex', gap: 4 }}>
                    <StatBadge label="✓" value={stats.completed} color={colors.success} />
                    <StatBadge label="✗" value={stats.failed} color={colors.danger} />
                  </div>
                </div>

                {/* Expanded Content */}
                {expanded.has(queue.name) && (
                  <div style={{ padding: '12px 20px' }}>
                    {/* Controls */}
                    {showControls && (
                      <div style={{
                        display: 'flex',
                        gap: 8,
                        marginBottom: 12,
                      }}>
                        <Button
                          onClick={() => queue.paused ? handleResume(queue.name) : handlePause(queue.name)}
                          color={queue.paused ? colors.success : colors.warning}
                          isDark={isDark}
                        >
                          {queue.paused ? '▶ Resume' : '⏸ Pause'}
                        </Button>
                        <Button
                          onClick={() => handleClear(queue.name)}
                          color={colors.danger}
                          isDark={isDark}
                        >
                          🗑 Clear
                        </Button>
                      </div>
                    )}

                    {/* Tasks */}
                    {tasks.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {tasks.slice(0, 5).map(task => (
                          <TaskItem key={task.id} task={task} colors={colors} />
                        ))}
                        {tasks.length > 5 && (
                          <div style={{
                            textAlign: 'center',
                            fontSize: 12,
                            color: colors.textSecondary,
                            padding: 8,
                          }}>
                            +{tasks.length - 5} more tasks
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{
                        fontSize: 13,
                        color: colors.textSecondary,
                        textAlign: 'center',
                        padding: 12,
                      }}>
                        No tasks in queue
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// Helper components
function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  if (value === 0) return null
  return (
    <span style={{
      background: `${color}20`,
      color,
      borderRadius: 6,
      padding: '2px 6px',
      fontSize: 11,
      fontWeight: 600,
    }}>
      {label} {value}
    </span>
  )
}

function Button({ 
  children, 
  onClick, 
  color,
  isDark,
}: { 
  children: React.ReactNode
  onClick: () => void
  color: string
  isDark: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: `${color}15`,
        color,
        border: `1px solid ${color}30`,
        borderRadius: 6,
        padding: '6px 12px',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        transition: 'all 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = `${color}25`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = `${color}15`
      }}
    >
      {children}
    </button>
  )
}

function TaskItem({ task, colors }: { task: Task; colors: Record<string, string> }) {
  const statusColors: Record<string, string> = {
    pending: colors.warning,
    running: colors.primary,
    completed: colors.success,
    failed: colors.danger,
    cancelled: colors.textSecondary,
    deadletter: colors.danger,
  }

  return (
    <div style={{
      background: colors.bgSecondary,
      borderRadius: 8,
      padding: '8px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: statusColors[task.status] || colors.textSecondary,
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          color: colors.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {task.action}
        </div>
      </div>
      <span style={{
        fontSize: 11,
        color: statusColors[task.status],
        fontWeight: 500,
        textTransform: 'capitalize',
      }}>
        {task.status}
      </span>
    </div>
  )
}

export default QueuePanel
