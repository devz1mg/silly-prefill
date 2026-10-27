a/AppData\Local\hermes\cache\scratch\prefill-README-short.md → b/AppData\Local\hermes\cache\scratch\prefill-README-short.md
@@ -0,0 +1,47 @@
+# Silly Prefill
+
+Расширение для **SillyTavern 1.19+ / Chat Completion**. Версия **1.7.1**, автор — **devz1mg**.
+
+## Что умеет
+
+- **Function-prefill** — передаёт начало ответа через результат инструмента, чтобы модель продолжила текст. Источник: Custom prefill или **Start Reply With**. Gemini и GPT; native Claude — экспериментально.
+- **Кнопка `¶`** в меню ответа `…` — добавляет/убирает текущий prefill только визуально, без изменения контекста модели.
+- **Внешние блоки** — запросы через Connection Manager: текст сверху/снизу, Rewrite или скрытые заметки. Есть условия, шаблоны и Undo.
+- **Визуальный Rewrite** — выберите в блоке **Chat history → «Только визуально — в историю только оригинал»**. В чате видна редакция, модель получает оригинал. Действует со следующего запуска; результат хранится в metadata. Явный `{{targetMessage}}` передаёт блоку видимый текст.
+- **Additional Parameters** — body/header-поля и исключения через YAML, отдельно по источникам. Нужен серверный плагин.
+
+## Последние обновления
+
+- **1.7.1:** авторство devz1mg и явное обозначение визуального Rewrite.
+- **1.7.0:** GPT function-prefill, экспериментальный `argon-exp-proto-v2`, GPT Fernet-shaped token и кнопки генерации. Старый protobuf сохранён.
+
+Для Gemini обычно оставляйте **AUTO**. `argon-exp-proto-v2` выбирается отдельно в **Thought signature mode**. Для GPT прикрепление reasoning-токена, декларация функции и нормализация sampling по умолчанию выключены. AUTO не создаёт GPT-токен автоматически.
+
+**Важно:** синтетические protobuf/Fernet-токены — эксперимент, не подписи провайдера и не доступ к скрытой думалке. Совместимость зависит от API/прокси. Fetch signature и внешние блоки могут расходовать оплачиваемые токены. Часть совместимых форматов основана на Kuro Prefill.
+
+## Установка расширения
+
+1. В Tavern откройте **Extensions → Install extension**.
+2. Вставьте `https://github.com/devz1mg/silly-prefill` и установите.
+3. Нажмите **Ctrl+F5**, откройте **Silly Prefill** и задайте prefill.
+
+Не включайте одновременно другие расширения с таким же function-prefill. Ядро и токенизатор не обновляются. Если автоматический Show reply prefix не работает на вашем ядре, используйте `¶`.
+
+## Установка серверного плагина
+
+Нужен для **Additional Parameters** и серверной вставки Claude thinking. Для `¶` и визуального Rewrite не нужен. Автоматически вместе с клиентским расширением не устанавливается.
+
+1. Возьмите **`server-plugin/silly-prefill-params`** из установленного расширения или распакованного репозитория.
+2. Скопируйте **внутреннюю папку `silly-prefill-params`** в `plugins` вашей Tavern. Итоговый путь:
+   ```text
+   SillyTavern/plugins/silly-prefill-params/index.js
+   ```
+   Неправильно: `plugins/server-plugin/silly-prefill-params/index.js`.
+3. В **`SillyTavern/config.yaml`** найдите настройку и выставьте:
+   ```yaml
+   enableServerPlugins: true
+   ```
+4. Полностью перезапустите сервер Tavern и обновите страницу.
+5. В **Silly Prefill → Additional Parameters** проверьте **Server plugin: installed**. Если не найден — проверьте путь, настройку и перезапуск.
+
+Не публикуйте ключи, signatures и приватные экспорты. [Issues](https://github.com/devz1mg/silly-prefill/issues) · [LICENSE](LICENSE); права сторонних авторов сохраняются.
