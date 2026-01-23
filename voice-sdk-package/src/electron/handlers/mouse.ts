/**
 * Mouse Handler
 * 
 * Mouse control for automation.
 * Note: Requires robotjs for actual mouse control.
 * This is a mock implementation for type safety.
 */

import { ipcMain, screen } from 'electron'
import type { MousePosition } from '../types'

// Type for robotjs (optional dependency)
interface RobotJS {
  moveMouse: (x: number, y: number) => void
  mouseClick: (button?: string, double?: boolean) => void
  getMousePos: () => { x: number; y: number }
  scrollMouse: (x: number, y: number) => void
  mouseToggle: (down?: string, button?: string) => void
}

let robot: RobotJS | null = null

// Try to load robotjs (optional dependency)
try {
  robot = require('robotjs') as RobotJS
} catch {
  console.warn('robotjs not available - mouse control will use fallback')
}

/**
 * Move the mouse to a position
 */
export function moveMouse(x: number, y: number): void {
  if (robot) {
    robot.moveMouse(x, y)
  } else {
    console.log(`[Mock] Mouse moved to (${x}, ${y})`)
  }
}

/**
 * Click the mouse
 */
export function clickMouse(button: 'left' | 'right' = 'left', double = false): void {
  if (robot) {
    robot.mouseClick(button, double)
  } else {
    console.log(`[Mock] Mouse ${button} ${double ? 'double-' : ''}clicked`)
  }
}

/**
 * Get current mouse position
 */
export function getMousePosition(): MousePosition {
  if (robot) {
    const pos = robot.getMousePos()
    return { x: pos.x, y: pos.y }
  }
  
  // Fallback: return screen center
  const display = screen.getPrimaryDisplay()
  return {
    x: Math.floor(display.workAreaSize.width / 2),
    y: Math.floor(display.workAreaSize.height / 2),
  }
}

/**
 * Scroll the mouse wheel
 */
export function scrollMouse(x: number, y: number): void {
  if (robot) {
    robot.scrollMouse(x, y)
  } else {
    console.log(`[Mock] Mouse scrolled (${x}, ${y})`)
  }
}

/**
 * Drag from one position to another
 */
export function dragMouse(
  startX: number, 
  startY: number, 
  endX: number, 
  endY: number
): void {
  if (robot) {
    robot.moveMouse(startX, startY)
    robot.mouseToggle('down')
    robot.moveMouse(endX, endY)
    robot.mouseToggle('up')
  } else {
    console.log(`[Mock] Mouse dragged from (${startX}, ${startY}) to (${endX}, ${endY})`)
  }
}

/**
 * Register IPC handlers for mouse
 */
export function registerMouseHandlers(): void {
  ipcMain.handle('mouse:move', async (_event, x: number, y: number) => {
    moveMouse(x, y)
  })

  ipcMain.handle('mouse:click', async (_event, button?: 'left' | 'right', double?: boolean) => {
    clickMouse(button, double)
  })

  ipcMain.handle('mouse:position', async () => {
    return getMousePosition()
  })

  ipcMain.handle('mouse:scroll', async (_event, x: number, y: number) => {
    scrollMouse(x, y)
  })

  ipcMain.handle('mouse:drag', async (_event, startX: number, startY: number, endX: number, endY: number) => {
    dragMouse(startX, startY, endX, endY)
  })
}
