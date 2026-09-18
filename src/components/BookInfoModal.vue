<script setup>
/**
 * 书籍信息：书名、作者、简介。
 *
 * 导入时这三项是从正文里认出来的（认不出就退回文件名），认错了得有个地方改。
 * 简介也放进来，是因为它已经从正文里被单独收走 —— 用户应该能编辑它。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({
  book: { type: Object, required: true },
});
const emit = defineEmits(['save', 'close']);

const title = ref(props.book.title || '');
const author = ref(props.book.author || '');
const summary = ref(props.book.summary || '');

function save() {
  emit('save', {
    title: title.value,
    author: author.value,
    summary: summary.value,
  });
}

/* Escape 关掉。App.vue 里那个 Escape 处理的是它自己管的两个弹窗，
   这个挂在侧栏下，自己收自己的场。 */
function handleKey(event) {
  if (event.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', handleKey));
onBeforeUnmount(() => window.removeEventListener('keydown', handleKey));
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal book-info-modal">
      <div class="modal-header">
        <div><p class="eyebrow">书架管理</p><h2>书籍信息</h2></div>
        <button class="close-button" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </div>

      <div class="settings-form">
        <label class="field">
          <span>书名</span>
          <input v-model="title" type="text" placeholder="书名" />
        </label>
        <label class="field">
          <span>作者</span>
          <input v-model="author" type="text" placeholder="本地文本" />
        </label>
        <label class="field">
          <span>内容简介</span>
          <textarea v-model="summary" rows="6" placeholder="导入时从正文里认出来的「内容简介」，可以改也可以清空。" />
        </label>
      </div>

      <div class="modal-footer">
        <button class="secondary-button" type="button" @click="emit('close')">取消</button>
        <button class="primary-button" type="button" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>
