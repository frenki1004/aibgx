/**
 * Oversight - thin lifecycle manager for oversight mode.
 * Delegates all action management and rendering to ManualPlay.
 * Handles auto-approve timer and pause state.
 */
const Oversight = {
  active: false,
  reviewing: false,
  paused: false,
  turn: null,

  // Auto-approve timer
  autoApproveDelay: 500, // ms
  autoApproveTimer: null,
  reviewStartTime: null,
  countdownInterval: null,

  // --- Lifecycle ---

  activate() {
    this.active = true;
    this.paused = false;
    this.reviewing = false;
    Panels.addTerminalMessage('Oversight mode activated', 'success');
  },

  deactivate() {
    this.active = false;
    this.reviewing = false;
    this.stopAutoApprove();
    if (typeof ManualPlay !== 'undefined') ManualPlay.deactivateOversight();
    Panels.addTerminalMessage('Oversight mode deactivated', 'info');
  },

  // --- Review flow ---

  handleReview(data) {
    this.reviewing = true;
    this.turn = data.turn;
    this.reviewStartTime = Date.now();

    // Activate ManualPlay in oversight mode with both teams' actions
    if (typeof ManualPlay !== 'undefined') {
      ManualPlay.activateOversight(data.actions.team0 || [], data.actions.team1 || []);
    }

    if (!this.paused) {
      this.startAutoApprove();
    }

    Panels.updateOversightCountdown(this.autoApproveDelay);
  },

  approve() {
    if (!this.reviewing) return;
    this.stopAutoApprove();

    // Read both teams' actions from ManualPlay
    const queues = ManualPlay._oversightQueues;
    App.send({
      type: 'OVERSIGHT_APPROVE',
      actions: {
        team0: queues ? queues[0] : [],
        team1: queues ? queues[1] : [],
      },
    });

    this.reviewing = false;
    ManualPlay.clearSelection();
    Panels.updateOversightCountdown(null);
    Panels.addTerminalMessage(`Turn ${this.turn}: Approved`, 'success');
  },

  // --- Auto-approve timer ---

  startAutoApprove() {
    this.stopAutoApprove();
    this.autoApproveTimer = setTimeout(() => this.approve(), this.autoApproveDelay);
    this.countdownInterval = setInterval(() => this._updateCountdown(), 50);
  },

  stopAutoApprove() {
    if (this.autoApproveTimer) {
      clearTimeout(this.autoApproveTimer);
      this.autoApproveTimer = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  },

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      this.stopAutoApprove();
    } else if (this.reviewing) {
      this.reviewStartTime = Date.now();
      this.startAutoApprove();
    }
    Panels.updateOversightPause(this.paused);
    Panels.addTerminalMessage(this.paused ? 'Oversight paused' : 'Oversight resumed', 'info');
  },

  _updateCountdown() {
    if (!this.reviewStartTime) return;
    const elapsed = Date.now() - this.reviewStartTime;
    const remaining = Math.max(0, this.autoApproveDelay - elapsed);
    Panels.updateOversightCountdown(remaining > 0 ? remaining : null);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Oversight;
}
