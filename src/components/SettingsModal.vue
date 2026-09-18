<script setup>
/** 设置：称呼、每日目标、标点宽松、备份的导出与导入、清空练习记录。 */
import { ref } from 'vue';

import { api } from '../api/index.js';
import {
  backend, clearPracticeRecords, loadDailyAndSessions, loadLibraryFromSnapshot,
  loadSnapshot, saveSetting, showToast, state,
} from '../composables/useStore.js';
import { dateKey } from '../core/index.js';

const emit = defineEmits(['close']);

const nickname = ref(state.settings.nickname || '');
const goal = ref(Number(state.settings.dailyGoal) || 800);
const punctLenient = ref(Boolean(state.settings.punctLenient));
const importMode = ref('merge');
const backupInput = ref(null);
const busy = ref(false);

async function save() {
  await saveSetting('nickname', nickname.value.trim());
  await saveSetting('dailyGoal', Math.max(50, Math.min(100000, Number(goal.value) || 800)));
  await saveSetting('punctLenient', punctLenient.value);
  showToast('设置已保存');
  emit('close');
}

async function exportBackup() {
  busy.value = true;
  try {
    const payload = await api.exportPayload();
    payload.exportedAt = new Date().toISOString();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `moji-backup-${dateKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('备份已导出');
  } catch (error) {
    showToast(`导出失败：${error.message}`);
  } finally {
    busy.value = false;
  }
}

async function importBackup(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  busy.value = true;
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || payload.app !== 'MoJi' || !Array.isArray(payload.books)) {
      showToast('这不是墨迹的备份文件');
      return;
    }
    await api.importPayload(payload, importMode.value);
    await loadSnapshot();
    loadLibraryFromSnapshot();
    loadDailyAndSessions();
    showToast(importMode.value === 'overwrite' ? '已用备份覆盖本地数据' : '已合并备份数据');
  } catch (error) {
    showToast(`导入失败：${error.message}`);
  } finally {
    busy.value = false;
  }
}

async function clearRecords() {
  if (!window.confirm('清空全部练习记录？书架里的书与抄写进度都会保留，但统计、连续天数与每日目标进度会归零。')) return;
  try {
    await clearPracticeRecords();
    showToast('练习记录已清空');
  } catch (error) {
    showToast(`清空失败：${error.message}`);
  }
}
</script>

<template>
  <div class="modal-backdrop">
    <div class="modal">
      <div class="modal-header">
        <div><p class="eyebrow">偏好</p><h2>设置</h2></div>
        <button class="close-button" type="button" @click="emit('close')">×</button>
      </div>

      <div class="settings-form">
        <label class="field">
          <span>怎么称呼你</span>
          <input v-model="nickname" type="text" placeholder="抄书人" />
        </label>
        <label class="field">
          <span>每日目标（字）</span>
          <input v-model="goal" type="number" min="50" max="100000" step="50" />
        </label>
        <label class="field checkbox">
          <input v-model="punctLenient" type="checkbox" />
          <span>标点宽松：全角/半角、中英文引号不算错</span>
        </label>
      </div>

      <div class="panel-divider"></div>

      <div class="settings-form">
        <div class="field">
          <span>备份</span>
          <div class="button-row">
            <button class="secondary-button" type="button" :disabled="busy" @click="exportBackup">导出备份</button>
            <button class="secondary-button" type="button" :disabled="busy" @click="backupInput.click()">导入备份</button>
          </div>
        </div>
        <label class="field checkbox">
          <input v-model="importMode" type="radio" value="merge" />
          <span>合并（同名覆盖，保留其余）</span>
        </label>
        <label class="field checkbox">
          <input v-model="importMode" type="radio" value="overwrite" />
          <span>覆盖（先清空本地数据）</span>
        </label>
        <button class="secondary-button danger" type="button" @click="clearRecords">清空练习记录</button>
        <p class="settings-hint">
          数据位置：{{ backend.dbPath || '（未连接）' }}
        </p>
      </div>

      <div class="modal-footer">
        <button class="secondary-button" type="button" @click="emit('close')">取消</button>
        <button class="primary-button" type="button" @click="save">保存</button>
      </div>

      <input ref="backupInput" type="file" accept=".json" hidden @change="importBackup" />
    </div>
  </div>
</template>
