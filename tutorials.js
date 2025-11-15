// Tutorials Page Dynamic Content Handler

class TutorialsManager {
  constructor() {
    this.currentUser = null;
    this.lessonsData = null;
    this.currentFilter = 'all';
    this.loading = true;
    this.error = null;
  }
  
  async init() {
    try {
      console.log('[Tutorials] Initializing...');
      this.showLoadingState();
      
      // Get current user
      const userResult = await window.api.invoke('get-current-user');
      if (userResult.success) {
        this.currentUser = userResult.data;
        console.log('[Tutorials] Current user:', this.currentUser);
      }
      
      // Fetch lessons for the user
      await this.fetchLessons();
      
      // Setup event listeners
      this.setupEventListeners();
      
      // Initial render
      this.renderContent();
      
      this.hideLoadingState();
    } catch (error) {
      console.error('[Tutorials] Initialization error:', error);
      this.showError(error.message);
    }
  }
  
  async fetchLessons() {
    try {
      console.log('[Tutorials] Fetching lessons...');
      const result = await window.api.invoke('fetch-user-lessons', this.currentUser?.id);
      
      // Debug: Raw API result
      
      if (result.success) {
        this.lessonsData = result.data;
      // Validate data structure
      const validation = {
        hasUser: !!this.lessonsData.user,
        hasFeatured: !!this.lessonsData.featured,
        hasCategories: !!this.lessonsData.categories,
        featuredCount: this.lessonsData.featured?.length || 0,
        categoryCount: Object.keys(this.lessonsData.categories || {}).length
      };
        
        // Validate required fields
        if (!this.lessonsData.user || !this.lessonsData.featured || !this.lessonsData.categories) {
        console.warn('[Tutorials] Missing required fields in API response:', Object.keys(this.lessonsData));
        }
      } else {
        throw new Error(result.error || 'Failed to fetch lessons');
      }
    } catch (error) {
      console.error('[Tutorials] Error fetching lessons:', error);
      console.error('[Tutorials] Error stack:', error.stack);
      throw error;
    }
  }
  
  showLoadingState() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.style.display = 'flex';
    }
  }
  
  hideLoadingState() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.style.display = 'none';
    }
  }
  
  showError(message) {
    const errorContainer = document.getElementById('errorContainer');
    if (errorContainer) {
      errorContainer.innerHTML = `
        <div style="background: rgba(255, 0, 0, 0.1); border: 1px solid rgba(255, 0, 0, 0.3); padding: 20px; border-radius: 8px; margin: 20px;">
          <h3 style="color: #ff5555;">Error Loading Content</h3>
          <p style="color: rgba(255, 255, 255, 0.8);">${message}</p>
          <button onclick="location.reload()" style="margin-top: 10px; padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">
            Retry
          </button>
        </div>
      `;
      errorContainer.style.display = 'block';
    }
    this.hideLoadingState();
  }
  
  renderContent() {
    if (!this.lessonsData) {
      console.error('[Tutorials] No lessons data to render');
      this.showError('No lesson data available. Please try refreshing the page.');
      return;
    }
    
    try {
      // Update user progress display
      this.renderUserProgress();
      
      // Render featured carousel
      this.renderFeaturedCarousel();
      
      // Render category sections
      this.renderCategorySections();
      
      // Update navigation items based on available categories
      this.updateNavigation();
    } catch (error) {
      console.error('[Tutorials] Error rendering content:', error);
      this.showError(`Failed to display content: ${error.message}`);
    }
  }
  
  renderUserProgress() {
    const heroSubtitle = document.querySelector('.hero-subtitle');
    if (heroSubtitle && this.lessonsData.user) {
      const { progress } = this.lessonsData.user;
      if (progress) {
        heroSubtitle.innerHTML = `
          Welcome back, ${this.lessonsData.user.name}! 
          <span style="display: block; margin-top: 10px; font-size: 0.9em; opacity: 0.8;">
            ${progress.completed} completed • ${progress.inProgress} in progress • ${progress.total} total lessons
          </span>
        `;
      }
    }
  }
  
  renderFeaturedCarousel() {
    const carousel = document.querySelector('.feature-carousel');
    if (!carousel || !this.lessonsData.featured) return;
    
    carousel.innerHTML = this.lessonsData.featured.map(feature => `
      <div class="feature-card" 
           style="background: linear-gradient(135deg, ${feature.thumbnail.colors.join(', ')});"
           data-url="${feature.url}"
           data-id="${feature.id}">
        ${feature.progress > 0 ? this.renderProgressBar(feature.progress) : ''}
        <div class="play-button">
          <div class="play-icon"></div>
        </div>
        <div class="feature-content">
          <h3 class="feature-title">
            ${feature.title}
            ${feature.recommended ? '<span class="badge recommended">Recommended</span>' : ''}
          </h3>
          <p class="feature-description">${feature.description}</p>
        </div>
      </div>
    `).join('');
    
    // Add click handlers
    carousel.querySelectorAll('.feature-card').forEach(card => {
      card.addEventListener('click', () => this.openLesson(card.dataset.url, card.dataset.id));
    });
  }
  
  renderCategorySections() {
    const container = document.getElementById('contentSections');
    if (!container || !this.lessonsData.categories) return;
    
    container.innerHTML = '';
    
    // Render "Continue Watching" section if there are in-progress lessons
    if (this.lessonsData.continueWatching && this.lessonsData.continueWatching.length > 0) {
      const continueSection = this.renderContinueWatchingSection();
      if (continueSection) {
        container.appendChild(continueSection);
      }
    }
    
    // Render each category
    Object.entries(this.lessonsData.categories).forEach(([categoryKey, category]) => {
      const section = this.renderCategorySection(categoryKey, category);
      if (section) {
        container.appendChild(section);
      }
    });
  }
  
  renderContinueWatchingSection() {
    const continueIds = this.lessonsData.continueWatching;
    const continueLessons = [];
    
    // Find lessons from continueWatching IDs
    Object.values(this.lessonsData.categories).forEach(category => {
      category.lessons.forEach(lesson => {
        if (continueIds.includes(lesson.id)) {
          continueLessons.push(lesson);
        }
      });
    });
    
    if (continueLessons.length === 0) return null;
    
    const section = document.createElement('div');
    section.className = 'content-section';
    section.dataset.category = 'continue';
    
    section.innerHTML = `
      <h2 class="section-title">Continue Watching</h2>
      <div class="tutorial-grid">
        ${continueLessons.map(lesson => this.renderLessonCard(lesson)).join('')}
      </div>
    `;
    
    // Add click handlers
    section.querySelectorAll('.tutorial-card').forEach(card => {
      card.addEventListener('click', () => this.openLesson(card.dataset.url, card.dataset.id));
    });
    
    return section;
  }
  
  renderCategorySection(categoryKey, category) {
    if (!category.lessons || category.lessons.length === 0) return null;
    
    const section = document.createElement('div');
    section.className = 'content-section';
    section.dataset.category = categoryKey;
    
    section.innerHTML = `
      <h2 class="section-title">${category.name}</h2>
      <div class="tutorial-grid">
        ${category.lessons.map(lesson => this.renderLessonCard(lesson)).join('')}
      </div>
    `;
    
    // Add click handlers
    section.querySelectorAll('.tutorial-card').forEach(card => {
      card.addEventListener('click', () => this.openLesson(card.dataset.url, card.dataset.id));
    });
    
    return section;
  }
  
  renderLessonCard(lesson) {
    const gradientColors = lesson.thumbnail?.colors || ['#667eea', '#764ba2'];
    
    return `
      <div class="tutorial-card" 
           data-category="${lesson.category || 'general'}" 
           data-url="${lesson.url}"
           data-id="${lesson.id}">
        <div class="tutorial-thumbnail" 
             style="background: linear-gradient(135deg, ${gradientColors.join(', ')});">
          ${lesson.progress > 0 ? this.renderProgressBar(lesson.progress) : ''}
        </div>
        <div class="tutorial-duration">${lesson.duration}</div>
        ${lesson.new ? '<div class="badge new">NEW</div>' : ''}
        ${lesson.completed ? '<div class="badge completed">✓</div>' : ''}
        ${lesson.recommended ? '<div class="badge recommended">★</div>' : ''}
        <div class="tutorial-overlay">
          <h3 class="tutorial-title">${lesson.title}</h3>
          <p class="tutorial-description">${lesson.description}</p>
        </div>
      </div>
    `;
  }
  
  renderProgressBar(progress) {
    return `
      <div class="progress-bar" style="position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background: rgba(0,0,0,0.3);">
        <div style="width: ${progress}%; height: 100%; background: #4CAF50; transition: width 0.3s;"></div>
      </div>
    `;
  }
  
  updateNavigation() {
    const navItems = document.querySelector('.nav-items');
    if (!navItems || !this.lessonsData.categories) return;
    
    // Clear existing items
    navItems.innerHTML = '';
    
    // Add "All" item
    const allItem = document.createElement('li');
    allItem.className = 'nav-item active';
    allItem.dataset.category = 'all';
    allItem.textContent = 'All';
    navItems.appendChild(allItem);
    
    // Add "Continue" if there are in-progress lessons
    if (this.lessonsData.continueWatching && this.lessonsData.continueWatching.length > 0) {
      const continueItem = document.createElement('li');
      continueItem.className = 'nav-item';
      continueItem.dataset.category = 'continue';
      continueItem.textContent = 'Continue';
      navItems.appendChild(continueItem);
    }
    
    // Add category items
    Object.entries(this.lessonsData.categories).forEach(([key, category]) => {
      if (category.lessons && category.lessons.length > 0) {
        const item = document.createElement('li');
        item.className = 'nav-item';
        item.dataset.category = key;
        item.textContent = category.name;
        navItems.appendChild(item);
      }
    });
  }
  
  setupEventListeners() {
    // Navigation filtering
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('nav-item')) {
        this.filterByCategory(e.target.dataset.category);
        
        // Update active state
        document.querySelectorAll('.nav-item').forEach(item => {
          item.classList.remove('active');
        });
        e.target.classList.add('active');
      }
    });
    
    // Refresh button
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        await this.fetchLessons();
        this.renderContent();
      });
    }
  }
  
  filterByCategory(category) {
    this.currentFilter = category;
    const sections = document.querySelectorAll('.content-section');
    
    sections.forEach(section => {
      if (category === 'all') {
        section.style.display = 'block';
      } else if (category === 'continue' && section.dataset.category === 'continue') {
        section.style.display = 'block';
      } else if (section.dataset.category === category) {
        section.style.display = 'block';
      } else {
        section.style.display = 'none';
      }
    });
  }
  
  async openLesson(url, lessonId) {
    // Find lesson details for comprehensive logging
    let lessonDetails = null;
    
    // Search in featured lessons
    const featuredLesson = this.lessonsData?.featured?.find(l => l.id === lessonId);
    if (featuredLesson) {
      lessonDetails = featuredLesson;
    } else {
      // Search in categories
      for (const category in (this.lessonsData?.categories || {})) {
        const lesson = this.lessonsData.categories[category].find(l => l.id === lessonId);
        if (lesson) {
          lessonDetails = { ...lesson, category };
          break;
        }
      }
    }
    
    // Log the lesson click with comprehensive details
    const logData = {
      action: 'lesson_clicked',
      lessonId: lessonId,
      url: url,
      title: lessonDetails?.title || 'Unknown',
      category: lessonDetails?.category || 'Unknown', 
      difficulty: lessonDetails?.difficulty || 'Unknown',
      duration: lessonDetails?.duration || 'Unknown',
      timestamp: new Date().toISOString(),
      userProgress: this.lessonsData?.user?.progress || 0,
      userLevel: this.lessonsData?.user?.level || 'Unknown'
    };
    
    console.log(`[Tutorials] Opening lesson:`, logData);
    
    // Send log event to main process
    if (window.api) {
      await window.api.invoke('log-lesson-click', logData);
    }
    
    // Track lesson start progress
    if (lessonId) {
      await window.api.invoke('update-lesson-progress', lessonId, 1);
    }
    
    // Open the URL
    if (window.api) {
      window.api.send('open-external-url', url);
    } else {
      window.open(url, '_blank');
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const manager = new TutorialsManager();
  manager.init();
});
