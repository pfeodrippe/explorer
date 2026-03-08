<template>
  <div id="pane-query" class="queries-left-pane pane">
    <tabs :items="['editor', 'browse', 'assistant']"
        v-model:active_tab="app_params.queries.query_tab"
        class="explorer-tab-content"
        v-on:changed="onTab">
      <template v-slot:editor>
        <query-editor 
          :conn="conn"
          v-model:query="query.expr">
        </query-editor>
      </template>
      <template v-slot:browse>
        <query-browser
          :conn="conn"
          v-model:query_name="query.name"
          v-model:query_kind="query.kind">
        </query-browser>
      </template>
      <template v-slot:assistant>
        <query-assistant
          :conn="conn"
          :host="app_params.host"
          :query="query.expr"
          :query_state="query"
          :query_result_state="props.query_result_state"
          @update:query="onUpdateQuery"
          @run="onRunQuery"
          @apply="onApplyQuery">
        </query-assistant>
      </template>
    </tabs>
  </div>
</template>

<script>
export default { name: "pane-query" }
</script>

<script setup>
import { defineProps, defineModel, computed } from 'vue';

const props = defineProps({
  conn: {type: Object, required: true},
  query_result_state: {type: Object, required: false, default: () => ({ seq: 0, value: {} })}
});

const app_params = defineModel("app_params");

const query = computed(() => {
  return app_params.value.queries;
});

const onTab = (evt) => {
  const isBrowse = evt.tab == "browse";
  if (!isBrowse) {
    query.value.kind = "query";
  }

  query.value.use_name = isBrowse;
}

const onUpdateQuery = (value) => {
  query.value.expr = value;
}

const onRunQuery = (value) => {
  query.value.expr = value;
  query.value.use_name = false;
}

const onApplyQuery = (value) => {
  query.value.expr = value;
  query.value.use_name = false;
  app_params.value.queries.query_tab = "editor";
}
</script>

<style scoped>
#pane-query {
  border-radius: var(--border-radius-medium);
}
</style>

<style>
.explorer-tab-content {
  padding: 0.5rem !important;
  padding-left: 0px !important;
}
</style>
