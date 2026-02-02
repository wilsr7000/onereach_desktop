/**
 * Task Manager - Full CRUD operations for task management
 * 
 * Features:
 * - Create, read, update, delete tasks
 * - Sort by priority, date, status
 * - Filter by status, tags, priority
 * - Persistent storage (localStorage)
 * - Optional Spaces sync
 * - Task templates
 * - Bulk operations
 */

class TaskManager {
  constructor(options = {}) {
    this.storageKey = options.storageKey || 'onereach-tasks'
    this.syncWithSpaces = options.syncWithSpaces || false
    this.spacesService = options.spacesService || null
    this.onTaskChange = options.onTaskChange || (() => {})
    
    // Load tasks from storage
    this.tasks = this.loadTasks()
  }

  /**
   * Load tasks from localStorage
   */
  loadTasks() {
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? JSON.parse(stored) : []
    } catch (error) {
      console.error('[TaskManager] Failed to load tasks:', error)
      return []
    }
  }

  /**
   * Save tasks to localStorage
   */
  saveTasks() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.tasks))
      this.onTaskChange(this.tasks)
      
      // Sync to Spaces if enabled
      if (this.syncWithSpaces && this.spacesService) {
        this.syncToSpaces()
      }
    } catch (error) {
      console.error('[TaskManager] Failed to save tasks:', error)
    }
  }

  /**
   * Generate unique task ID
   */
  generateId() {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Add a new task
   * @param {Object} taskData - Task properties
   * @returns {Object} Created task
   */
  add(taskData) {
    const task = {
      id: this.generateId(),
      title: taskData.title || 'Untitled Task',
      description: taskData.description || '',
      status: taskData.status || 'pending',
      priority: taskData.priority || 'medium',
      tags: taskData.tags || [],
      dueDate: taskData.dueDate || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      ...taskData
    }

    this.tasks.push(task)
    this.saveTasks()
    
    console.log('[TaskManager] Task added:', task.id)
    return task
  }

  /**
   * Get task by ID
   * @param {string} id - Task ID
   * @returns {Object|null} Task or null
   */
  get(id) {
    return this.tasks.find(task => task.id === id) || null
  }

  /**
   * Get all tasks
   * @param {Object} filters - Optional filters
   * @returns {Array} Filtered tasks
   */
  getAll(filters = {}) {
    let filtered = [...this.tasks]

    // Filter by status
    if (filters.status) {
      filtered = filtered.filter(task => task.status === filters.status)
    }

    // Filter by priority
    if (filters.priority) {
      filtered = filtered.filter(task => task.priority === filters.priority)
    }

    // Filter by tags
    if (filters.tags && filters.tags.length > 0) {
      filtered = filtered.filter(task => 
        filters.tags.some(tag => task.tags.includes(tag))
      )
    }

    // Filter by search query
    if (filters.search) {
      const query = filters.search.toLowerCase()
      filtered = filtered.filter(task => 
        task.title.toLowerCase().includes(query) ||
        task.description.toLowerCase().includes(query)
      )
    }

    // Filter by due date range
    if (filters.dueBefore) {
      filtered = filtered.filter(task => 
        task.dueDate && new Date(task.dueDate) <= new Date(filters.dueBefore)
      )
    }

    if (filters.dueAfter) {
      filtered = filtered.filter(task => 
        task.dueDate && new Date(task.dueDate) >= new Date(filters.dueAfter)
      )
    }

    return filtered
  }

  /**
   * Update task
   * @param {string} id - Task ID
   * @param {Object} updates - Properties to update
   * @returns {Object|null} Updated task or null
   */
  update(id, updates) {
    const task = this.get(id)
    if (!task) {
      console.warn('[TaskManager] Task not found:', id)
      return null
    }

    // Update properties
    Object.assign(task, updates, {
      updatedAt: new Date().toISOString()
    })

    // Set completedAt if status changed to completed
    if (updates.status === 'completed' && !task.completedAt) {
      task.completedAt = new Date().toISOString()
    }

    // Clear completedAt if status changed from completed
    if (updates.status && updates.status !== 'completed') {
      task.completedAt = null
    }

    this.saveTasks()
    
    console.log('[TaskManager] Task updated:', id)
    return task
  }

  /**
   * Delete task
   * @param {string} id - Task ID
   * @returns {boolean} Success
   */
  delete(id) {
    const index = this.tasks.findIndex(task => task.id === id)
    if (index === -1) {
      console.warn('[TaskManager] Task not found:', id)
      return false
    }

    this.tasks.splice(index, 1)
    this.saveTasks()
    
    console.log('[TaskManager] Task deleted:', id)
    return true
  }

  /**
   * Sort tasks
   * @param {string} sortBy - Sort field
   * @param {string} order - 'asc' or 'desc'
   * @returns {Array} Sorted tasks
   */
  sort(sortBy = 'createdAt', order = 'desc') {
    const sorted = [...this.tasks].sort((a, b) => {
      let comparison = 0

      switch (sortBy) {
        case 'priority':
          const priorityOrder = { high: 3, medium: 2, low: 1 }
          comparison = priorityOrder[a.priority] - priorityOrder[b.priority]
          break

        case 'status':
          const statusOrder = { pending: 1, 'in-progress': 2, completed: 3, cancelled: 4 }
          comparison = statusOrder[a.status] - statusOrder[b.status]
          break

        case 'dueDate':
          if (!a.dueDate && !b.dueDate) comparison = 0
          else if (!a.dueDate) comparison = 1
          else if (!b.dueDate) comparison = -1
          else comparison = new Date(a.dueDate) - new Date(b.dueDate)
          break

        case 'title':
          comparison = a.title.localeCompare(b.title)
          break

        case 'createdAt':
        case 'updatedAt':
        case 'completedAt':
          const dateA = a[sortBy] ? new Date(a[sortBy]) : new Date(0)
          const dateB = b[sortBy] ? new Date(b[sortBy]) : new Date(0)
          comparison = dateA - dateB
          break

        default:
          comparison = 0
      }

      return order === 'asc' ? comparison : -comparison
    })

    return sorted
  }

  /**
   * Bulk update tasks
   * @param {Array} ids - Task IDs
   * @param {Object} updates - Properties to update
   * @returns {Array} Updated tasks
   */
  bulkUpdate(ids, updates) {
    const updated = []

    ids.forEach(id => {
      const task = this.update(id, updates)
      if (task) updated.push(task)
    })

    return updated
  }

  /**
   * Bulk delete tasks
   * @param {Array} ids - Task IDs
   * @returns {number} Number of deleted tasks
   */
  bulkDelete(ids) {
    let deleted = 0

    ids.forEach(id => {
      if (this.delete(id)) deleted++
    })

    return deleted
  }

  /**
   * Get tasks by status
   */
  getPending() {
    return this.getAll({ status: 'pending' })
  }

  getInProgress() {
    return this.getAll({ status: 'in-progress' })
  }

  getCompleted() {
    return this.getAll({ status: 'completed' })
  }

  /**
   * Get tasks by priority
   */
  getHighPriority() {
    return this.getAll({ priority: 'high' })
  }

  getMediumPriority() {
    return this.getAll({ priority: 'medium' })
  }

  getLowPriority() {
    return this.getAll({ priority: 'low' })
  }

  /**
   * Get overdue tasks
   */
  getOverdue() {
    const now = new Date()
    return this.tasks.filter(task => 
      task.status !== 'completed' &&
      task.dueDate &&
      new Date(task.dueDate) < now
    )
  }

  /**
   * Get tasks due today
   */
  getDueToday() {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)

    return this.tasks.filter(task => {
      if (!task.dueDate || task.status === 'completed') return false
      const dueDate = new Date(task.dueDate)
      return dueDate >= today && dueDate < tomorrow
    })
  }

  /**
   * Get task statistics
   */
  getStats() {
    return {
      total: this.tasks.length,
      pending: this.getPending().length,
      inProgress: this.getInProgress().length,
      completed: this.getCompleted().length,
      overdue: this.getOverdue().length,
      dueToday: this.getDueToday().length,
      highPriority: this.getHighPriority().length
    }
  }

  /**
   * Search tasks
   * @param {string} query - Search query
   * @returns {Array} Matching tasks
   */
  search(query) {
    return this.getAll({ search: query })
  }

  /**
   * Export tasks to JSON
   * @returns {string} JSON string
   */
  export() {
    return JSON.stringify(this.tasks, null, 2)
  }

  /**
   * Import tasks from JSON
   * @param {string} json - JSON string
   * @returns {boolean} Success
   */
  import(json) {
    try {
      const imported = JSON.parse(json)
      if (!Array.isArray(imported)) {
        throw new Error('Invalid format: expected array')
      }

      // Merge with existing tasks (avoid duplicates)
      const existingIds = new Set(this.tasks.map(t => t.id))
      const newTasks = imported.filter(t => !existingIds.has(t.id))
      
      this.tasks.push(...newTasks)
      this.saveTasks()

      console.log('[TaskManager] Imported', newTasks.length, 'tasks')
      return true
    } catch (error) {
      console.error('[TaskManager] Import failed:', error)
      return false
    }
  }

  /**
   * Clear all tasks
   */
  clear() {
    this.tasks = []
    this.saveTasks()
    console.log('[TaskManager] All tasks cleared')
  }

  /**
   * Sync tasks to Spaces (if enabled)
   */
  async syncToSpaces() {
    if (!this.spacesService) return

    try {
      const noteTitle = 'Tasks - OneReach.ai'
      const content = this.export()

      await this.spacesService.saveNote({
        title: noteTitle,
        content: content,
        tags: ['tasks', 'onereach'],
        spaceId: 'default'
      })

      console.log('[TaskManager] Synced to Spaces')
    } catch (error) {
      console.error('[TaskManager] Spaces sync failed:', error)
    }
  }

  /**
   * Load tasks from Spaces
   */
  async loadFromSpaces() {
    if (!this.spacesService) return

    try {
      const noteTitle = 'Tasks - OneReach.ai'
      const note = await this.spacesService.getNote(noteTitle)

      if (note && note.content) {
        this.import(note.content)
        console.log('[TaskManager] Loaded from Spaces')
      }
    } catch (error) {
      console.error('[TaskManager] Failed to load from Spaces:', error)
    }
  }
}

module.exports = TaskManager
