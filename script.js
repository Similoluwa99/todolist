/**
 * Focus Tasks — Script
 * Works with the current index.html (minimalist redesign).
 * All data is saved to and loaded from localStorage so tasks
 * survive page refreshes.
 *
 * Features:
 *  - Full CRUD (Add / Edit / Confirm-Delete)
 *  - Recurring tasks: Daily, Weekly, Monthly, Yearly
 *  - Auto-advance due date on completion for recurring tasks + Undo toast
 *  - Real-time search
 *  - 4 filter tabs: All / In Progress / Recurring / Done (via stat cards)
 *  - Live stats counter at the top
 *  - Friendly empty state
 */

(function () {
  'use strict';

  /* =====================================================================
     Constants & State
  ===================================================================== */
  const STORAGE_KEY = 'focus_tasks_v1';

  let tasks          = [];
  let currentFilter  = 'all'; // 'all' | 'active' | 'recurring' | 'completed'
  let searchQuery    = '';
  let pendingDeleteId = null;
  let toastTimer     = null;

  /* =====================================================================
     DOM References
  ===================================================================== */
  const $ = id => document.getElementById(id);

  const els = {
    // Header stats
    totalCount     : $('total-count'),
    pendingCount   : $('pending-count'),
    recurringCount : $('recurring-count'),
    completedCount : $('completed-count'),
    headerTotalText: $('header-total-text'),

    // Date badge
    currentDateBadge: $('current-date-badge'),

    // Search
    searchInput   : $('search-input'),
    clearSearchBtn: $('clear-search-btn'),

    // Stat cards (also act as filter tabs)
    statCards: document.querySelectorAll('.stat-card'),

    // Add form
    addForm         : $('add-task-form'),
    titleInput      : $('task-title-input'),
    titleError      : $('title-error'),
    dueDateInput    : $('task-due-date-input'),
    dateError       : $('date-error'),
    datePill        : $('date-pill'),
    recurrenceInput : $('task-recurrence-input'),
    statusInput     : $('task-status-input'),
    addStatusLabel  : $('add-status-label'),

    // Task list & empty state
    taskList    : $('task-list'),
    emptyState  : $('empty-state'),
    emptyTitle  : $('empty-title'),
    emptyMessage: $('empty-message'),
    viewHeading : $('view-heading'),
    viewCounter : $('view-counter'),

    // Edit modal
    editModal         : $('edit-modal'),
    editForm          : $('edit-task-form'),
    editId            : $('edit-task-id'),
    editTitle         : $('edit-task-title'),
    editTitleError    : $('edit-title-error'),
    editDueDate       : $('edit-task-due-date'),
    editDateError     : $('edit-date-error'),
    editRecurrence    : $('edit-task-recurrence'),
    editStatus        : $('edit-task-status'),
    editStatusLabel   : $('edit-status-label'),
    closeEditModalBtn : $('close-edit-modal-btn'),
    cancelEditBtn     : $('cancel-edit-btn'),

    // Delete modal
    deleteModal       : $('delete-modal'),
    deleteTaskPreview : $('delete-task-preview'),
    confirmDeleteBtn  : $('confirm-delete-btn'),
    cancelDeleteBtn   : $('cancel-delete-btn'),

    // Toast
    toast        : $('toast'),
    toastMessage : $('toast-message'),
    toastUndoBtn : $('toast-undo-btn'),
  };

  /* =====================================================================
     localStorage
  ===================================================================== */
  function loadTasks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) { tasks = parsed; return; }
      }
    } catch (e) {
      console.warn('Could not read tasks from localStorage:', e);
    }
    tasks = [];
  }

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (e) {
      console.warn('Could not write tasks to localStorage:', e);
    }
  }

  /* =====================================================================
     Date Helpers
  ===================================================================== */
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function parseDateLocal(str) {
    if (!str) return null;
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatDisplayDate(str) {
    const d = parseDateLocal(str);
    if (!d) return null;

    const today    = parseDateLocal(todayStr());
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const diff     = d - today;

    let label, cls;
    if (diff < 0)             { label = `Overdue · ${d.toLocaleDateString(undefined,{month:'short',day:'numeric'})}`;  cls = 'date-overdue'; }
    else if (diff === 0)      { label = 'Today';     cls = 'date-today'; }
    else if (d - tomorrow === 0) { label = 'Tomorrow'; cls = 'date-tomorrow'; }
    else                      { label = d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); cls = 'date-normal'; }

    return { label, cls };
  }

  function nextOccurrence(str, recurrence) {
    const base = parseDateLocal(str) || new Date();
    const next = new Date(base);
    switch (recurrence) {
      case 'daily'  : next.setDate(next.getDate() + 1);       break;
      case 'weekly' : next.setDate(next.getDate() + 7);       break;
      case 'monthly': next.setMonth(next.getMonth() + 1);     break;
      case 'yearly' : next.setFullYear(next.getFullYear()+1); break;
      default       : return str;
    }
    return `${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())}`;
  }

  function recurrenceLabel(r) {
    return { daily:'Daily', weekly:'Weekly', monthly:'Monthly', yearly:'Yearly' }[r] || null;
  }

  /* =====================================================================
     Stats & Date Badge
  ===================================================================== */
  function updateStats() {
    const total     = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const active    = total - completed;
    const recurring = tasks.filter(t => t.recurrence && t.recurrence !== 'none').length;

    els.totalCount.textContent     = total;
    els.pendingCount.textContent   = active;
    els.recurringCount.textContent = recurring;
    els.completedCount.textContent = completed;
    els.headerTotalText.textContent = `${total} ${total === 1 ? 'task' : 'tasks'}`;
  }

  function updateDateBadge() {
    const d = new Date();
    els.currentDateBadge.textContent = d.toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }

  /* =====================================================================
     Render
  ===================================================================== */
  const FILTER_LABELS = { all:'All Tasks', active:'In Progress', recurring:'Recurring', completed:'Done' };

  function getFilteredTasks() {
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter(t => {
      if (currentFilter === 'active'    && t.completed)                        return false;
      if (currentFilter === 'completed' && !t.completed)                       return false;
      if (currentFilter === 'recurring' && (!t.recurrence || t.recurrence === 'none')) return false;
      if (q) {
        return t.title.toLowerCase().includes(q) ||
               (t.dueDate && t.dueDate.includes(q)) ||
               (t.recurrence && t.recurrence.includes(q));
      }
      return true;
    });
  }

  function render() {
    updateStats();

    const filtered = getFilteredTasks();
    els.viewHeading.textContent = FILTER_LABELS[currentFilter] || 'Tasks';
    els.viewCounter.textContent = `${filtered.length} ${filtered.length === 1 ? 'item' : 'items'}`;

    if (filtered.length === 0) {
      els.taskList.innerHTML = '';
      els.taskList.hidden    = true;
      els.emptyState.hidden  = false;

      if (tasks.length === 0) {
        els.emptyTitle.textContent   = 'No tasks yet';
        els.emptyMessage.textContent = 'Type a task above and press Add to get started.';
      } else if (searchQuery.trim()) {
        els.emptyTitle.textContent   = 'No results found';
        els.emptyMessage.textContent = `Nothing matched "${searchQuery}". Try a different search.`;
      } else {
        els.emptyTitle.textContent   = 'All clear here!';
        els.emptyMessage.textContent = currentFilter === 'completed'
          ? 'No completed tasks yet. Mark a task done to see it here.'
          : 'No tasks in this view.';
      }
      return;
    }

    els.taskList.hidden   = false;
    els.emptyState.hidden = true;
    els.taskList.innerHTML = '';
    filtered.forEach(t => els.taskList.appendChild(buildTaskItem(t)));
  }

  function buildTaskItem(task) {
    const li = document.createElement('li');
    li.className = `task-item${task.completed ? ' is-completed' : ''}`;
    li.dataset.id = task.id;

    /* -- Checkbox -- */
    const checkWrap = document.createElement('div');
    checkWrap.className = 'task-check-wrap';

    const checkLabel = document.createElement('label');
    checkLabel.className = 'round-checkbox';
    checkLabel.title = task.completed ? 'Mark as not done' : 'Mark as done';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = task.completed;
    cb.setAttribute('aria-label', (task.completed ? 'Uncheck' : 'Check') + ` "${task.title}"`);
    cb.addEventListener('change', () => toggleTask(task.id));

    const mark = document.createElement('span');
    mark.className = 'round-checkbox-mark';

    checkLabel.append(cb, mark);
    checkWrap.append(checkLabel);

    /* -- Body -- */
    const body = document.createElement('div');
    body.className = 'task-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'task-title';
    titleEl.textContent = task.title;

    body.append(titleEl);

    // Tags row
    const tags = buildTagsRow(task);
    if (tags.children.length) body.append(tags);

    /* -- Actions -- */
    const actions = document.createElement('div');
    actions.className = 'task-actions';

    if (task.recurrence && task.recurrence !== 'none') {
      const advBtn = iconBtn('btn-advance', 'Advance to next cycle',
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 4 15 12 5 20 5 4"></polygon>
          <line x1="19" y1="5" x2="19" y2="19"></line>
        </svg>`
      );
      advBtn.addEventListener('click', () => advanceRecurrence(task.id));
      actions.append(advBtn);
    }

    const editBtn = iconBtn('btn-edit', 'Edit task',
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
      </svg>`
    );
    editBtn.addEventListener('click', () => openEditModal(task.id));

    const delBtn = iconBtn('btn-delete', 'Delete task',
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>`
    );
    delBtn.addEventListener('click', () => openDeleteModal(task.id));

    actions.append(editBtn, delBtn);

    li.append(checkWrap, body, actions);
    return li;
  }

  function buildTagsRow(task) {
    const row = document.createElement('div');
    row.className = 'task-tags';

    // Status badge
    const statusBadge = document.createElement('span');
    statusBadge.className = `tag-badge ${task.completed ? 'tag-status-done' : ''}`;
    statusBadge.innerHTML = task.completed
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Done`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg> Active`;
    row.append(statusBadge);

    // Due date
    if (task.dueDate) {
      const info = formatDisplayDate(task.dueDate);
      if (info) {
        const dateBadge = document.createElement('span');
        dateBadge.className = `tag-badge ${info.cls}`;
        dateBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="18" rx="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg> ${info.label}`;
        row.append(dateBadge);
      }
    }

    // Recurrence badge
    const rl = recurrenceLabel(task.recurrence);
    if (rl) {
      const recBadge = document.createElement('span');
      recBadge.className = 'tag-badge tag-recurring';
      recBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="17 1 21 5 17 9"></polyline>
        <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
        <polyline points="7 23 3 19 7 15"></polyline>
        <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
      </svg> ${rl}`;
      row.append(recBadge);
    }

    return row;
  }

  function iconBtn(cls, title, svgHtml) {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = `action-btn ${cls}`;
    btn.title     = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = svgHtml;
    return btn;
  }

  /* =====================================================================
     Task Operations
  ===================================================================== */
  function addTask(title, dueDate, recurrence, completed) {
    const task = {
      id        : `t_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      title,
      dueDate   : dueDate || '',
      recurrence: recurrence || 'none',
      completed : !!completed,
      createdAt : Date.now(),
    };
    tasks.unshift(task);
    saveTasks();
    render();
    return task;
  }

  function toggleTask(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    if (!task.completed && task.recurrence && task.recurrence !== 'none') {
      // Recurring: advance due date and keep active
      const prevDate   = task.dueDate;
      const prevStatus = task.completed;
      const nextDate   = nextOccurrence(task.dueDate, task.recurrence);

      task.dueDate   = nextDate;
      task.completed = false;
      saveTasks();
      render();

      const dateInfo = nextDate ? formatDisplayDate(nextDate) : null;
      showToast(
        `Done! Next: ${dateInfo ? dateInfo.label : nextDate} 🔁`,
        () => { task.dueDate = prevDate; task.completed = prevStatus; saveTasks(); render(); }
      );
    } else {
      task.completed = !task.completed;
      saveTasks();
      render();
    }
  }

  function advanceRecurrence(id) {
    const task = tasks.find(t => t.id === id);
    if (!task || !task.recurrence || task.recurrence === 'none') return;

    const prevDate = task.dueDate;
    task.dueDate   = nextOccurrence(task.dueDate, task.recurrence);
    task.completed = false;
    saveTasks();
    render();

    const dateInfo = formatDisplayDate(task.dueDate);
    showToast(
      `Moved to ${dateInfo ? dateInfo.label : task.dueDate} 🔁`,
      () => { task.dueDate = prevDate; saveTasks(); render(); }
    );
  }

  function deleteTask(id) {
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return;
    const [removed] = tasks.splice(idx, 1);
    saveTasks();
    render();
    showToast(
      `Deleted "${removed.title}"`,
      () => { tasks.splice(idx, 0, removed); saveTasks(); render(); }
    );
  }

  /* =====================================================================
     Add Form Handler
  ===================================================================== */
  function handleAddSubmit(e) {
    e.preventDefault();

    const title   = els.titleInput.value.trim();
    const dueDate = els.dueDateInput.value;

    // Validate title
    let hasError = false;
    if (!title) {
      els.titleError.textContent = 'Please enter a task description.';
      els.titleInput.focus();
      hasError = true;
    } else {
      els.titleError.textContent = '';
    }

    // Validate due date (now required)
    if (!dueDate) {
      els.dateError.textContent = 'Please select a due date.';
      if (els.datePill) els.datePill.classList.add('has-error');
      if (!hasError) els.dueDateInput.focus();
      hasError = true;
    } else {
      els.dateError.textContent = '';
      if (els.datePill) els.datePill.classList.remove('has-error');
    }

    if (hasError) return;

    addTask(
      title,
      dueDate,
      els.recurrenceInput.value,
      els.statusInput.checked
    );

    // Reset form
    els.addForm.reset();
    els.addStatusLabel.textContent = 'Done';
    if (els.datePill) els.datePill.classList.remove('has-error');
    els.titleInput.focus();
    showToast('Task added ✓');
  }

  /* =====================================================================
     Edit Modal
  ===================================================================== */
  function openEditModal(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    els.editId.value           = task.id;
    els.editTitle.value        = task.title;
    els.editDueDate.value      = task.dueDate || '';
    els.editRecurrence.value   = task.recurrence || 'none';
    els.editStatus.checked     = task.completed;
    els.editStatusLabel.textContent = task.completed ? 'Completed' : 'Mark as completed';
    els.editTitleError.textContent = '';

    showModal(els.editModal);
    els.editTitle.focus();
  }

  function closeEditModal() { hideModal(els.editModal); }

  function handleEditSubmit(e) {
    e.preventDefault();

    const title   = els.editTitle.value.trim();
    const dueDate = els.editDueDate.value;

    // Validate title
    let hasError = false;
    if (!title) {
      els.editTitleError.textContent = 'Please enter a task description.';
      els.editTitle.focus();
      hasError = true;
    } else {
      els.editTitleError.textContent = '';
    }

    // Validate due date (required)
    if (!dueDate) {
      els.editDateError.textContent = 'Please select a due date.';
      if (!hasError) els.editDueDate.focus();
      hasError = true;
    } else {
      els.editDateError.textContent = '';
    }

    if (hasError) return;

    const task = tasks.find(t => t.id === els.editId.value);
    if (task) {
      task.title      = title;
      task.dueDate    = dueDate;
      task.recurrence = els.editRecurrence.value || 'none';
      task.completed  = els.editStatus.checked;
      saveTasks();
      render();
      showToast('Task updated ✓');
    }

    closeEditModal();
  }

  /* =====================================================================
     Delete Modal
  ===================================================================== */
  function openDeleteModal(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    pendingDeleteId = id;
    els.deleteTaskPreview.textContent = task.title;
    showModal(els.deleteModal);
    els.confirmDeleteBtn.focus();
  }

  function closeDeleteModal() { pendingDeleteId = null; hideModal(els.deleteModal); }

  function handleConfirmDelete() {
    if (pendingDeleteId) deleteTask(pendingDeleteId);
    closeDeleteModal();
  }

  /* =====================================================================
     Modal Helpers
  ===================================================================== */
  function showModal(modal) {
    modal.hidden = false;
    modal.classList.add('active');
  }

  function hideModal(modal) {
    modal.hidden = true;
    modal.classList.remove('active');
  }

  /* =====================================================================
     Toast / Undo
  ===================================================================== */
  function showToast(message, undoCb) {
    if (toastTimer) clearTimeout(toastTimer);

    els.toastMessage.textContent = message;

    if (undoCb) {
      els.toastUndoBtn.hidden = false;
      els.toastUndoBtn.onclick = () => { undoCb(); hideToast(); };
    } else {
      els.toastUndoBtn.hidden = true;
      els.toastUndoBtn.onclick = null;
    }

    els.toast.hidden = false;
    toastTimer = setTimeout(hideToast, 5000);
  }

  function hideToast() {
    els.toast.hidden = true;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }

  /* =====================================================================
     Search & Filter
  ===================================================================== */
  function handleSearch() {
    searchQuery = els.searchInput.value;
    els.clearSearchBtn.hidden = !searchQuery;
    render();
  }

  function clearSearch() {
    els.searchInput.value = '';
    searchQuery = '';
    els.clearSearchBtn.hidden = true;
    render();
    els.searchInput.focus();
  }

  function setFilter(filter) {
    currentFilter = filter;
    els.statCards.forEach(card => {
      const isActive = card.dataset.filter === filter;
      card.classList.toggle('active', isActive);
      card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    render();
  }

  /* =====================================================================
     Event Wiring
  ===================================================================== */
  function wireEvents() {
    // Add form
    els.addForm.addEventListener('submit', handleAddSubmit);
    els.titleInput.addEventListener('input', () => {
      if (els.titleInput.value.trim()) els.titleError.textContent = '';
    });
    els.dueDateInput.addEventListener('change', () => {
      if (els.dueDateInput.value) {
        els.dateError.textContent = '';
        if (els.datePill) els.datePill.classList.remove('has-error');
      }
    });
    els.statusInput.addEventListener('change', () => {
      els.addStatusLabel.textContent = els.statusInput.checked ? 'Done' : 'Done';
    });

    // Search
    els.searchInput.addEventListener('input', handleSearch);
    els.clearSearchBtn.addEventListener('click', clearSearch);

    // Filter stat cards
    els.statCards.forEach(card => {
      card.addEventListener('click', () => setFilter(card.dataset.filter || 'all'));
    });

    // Edit modal
    els.editForm.addEventListener('submit', handleEditSubmit);
    els.closeEditModalBtn.addEventListener('click', closeEditModal);
    els.cancelEditBtn.addEventListener('click', closeEditModal);
    els.editModal.addEventListener('click', e => { if (e.target === els.editModal) closeEditModal(); });
    els.editTitle.addEventListener('input', () => {
      if (els.editTitle.value.trim()) els.editTitleError.textContent = '';
    });
    els.editDueDate.addEventListener('change', () => {
      if (els.editDueDate.value) els.editDateError.textContent = '';
    });
    els.editStatus.addEventListener('change', () => {
      els.editStatusLabel.textContent = els.editStatus.checked ? 'Completed' : 'Mark as completed';
    });

    // Delete modal
    els.confirmDeleteBtn.addEventListener('click', handleConfirmDelete);
    els.cancelDeleteBtn.addEventListener('click', closeDeleteModal);
    els.deleteModal.addEventListener('click', e => { if (e.target === els.deleteModal) closeDeleteModal(); });

    // Global ESC key
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!els.deleteModal.hidden) closeDeleteModal();
      else if (!els.editModal.hidden) closeEditModal();
    });
  }

  /* =====================================================================
     Init
  ===================================================================== */
  function init() {
    loadTasks();     // ← read from localStorage before anything else
    updateDateBadge();
    wireEvents();
    render();        // ← paint the loaded tasks immediately
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
