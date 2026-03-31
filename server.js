const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { 
  downloadYoutubeVideo, 
  getVideoInfo, 
  downloadThumbnail, 
  extractVideoFrame,
  DOWNLOADS_DIR,
  THUMBNAILS_DIR,
  getDownloadedFiles 
} = require('./youtube-downloader');

const app = express();
const PORT = process.env.PORT || 3001;

// 中間件
app.use(cors({
  origin: 'http://localhost:3001',
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname))); // 提供靜態文件

// 日誌中間件
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// 提供下載資料夾的靜態文件
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ===== YouTube 下載 API 端點 =====
app.post('/api/download-youtube', async (req, res) => {
  try {
    const { url, format = 'best' } = req.body;

    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return res.status(400).json({ error: 'YouTube URL 不能為空' });
    }

    console.log(`開始下載: ${url} (格式: ${format})`);

    const result = await downloadYoutubeVideo(url, format);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('下載錯誤:', error);
    res.status(500).json({
      error: '下載失敗，請稍後重試',
      details: error.message
    });
  }
});

// ===== 獲取已下載檔案列表 =====
app.get('/api/downloads', (req, res) => {
  try {
    const files = getDownloadedFiles();
    res.json({
      success: true,
      files: files,
      count: files.length
    });
  } catch (error) {
    console.error('獲取檔案列表錯誤:', error);
    res.status(500).json({ error: '無法獲取檔案列表' });
  }
});

// ===== 下載檔案 =====
app.get('/download/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(DOWNLOADS_DIR, filename);

    // 安全檢查，防止路徑遍歷攻擊
    if (!filepath.startsWith(DOWNLOADS_DIR)) {
      return res.status(403).json({ error: '禁止存取' });
    }

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: '檔案不存在' });
    }

    res.download(filepath, filename);
  } catch (error) {
    console.error('檔案下載錯誤:', error);
    res.status(500).json({ error: '下載失敗' });
  }
});

// ===== 刪除下載的檔案 =====
app.post('/api/delete-file', (req, res) => {
  try {
    const { filename } = req.body;

    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: '檔案名稱不能為空' });
    }

    const filepath = path.join(DOWNLOADS_DIR, filename);

    // 安全檢查，防止路徑遍歷攻擊
    if (!filepath.startsWith(DOWNLOADS_DIR)) {
      return res.status(403).json({ error: '禁止存取' });
    }

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: '檔案不存在' });
    }

    // 刪除主檔案
    try {
      fs.unlinkSync(filepath);
      console.log(`✓ 已刪除檔案: ${filename}`);
    } catch (unlinkErr) {
      return res.status(500).json({ error: '無法刪除檔案' });
    }

    // 嘗試刪除關聯的縮圖（如果存在）
    // 從文件名提取 videoId
    const videoIdMatch = filename.match(/\[([a-zA-Z0-9_-]+)_\d+\]/);
    if (videoIdMatch) {
      const videoId = videoIdMatch[1];
      const thumbnailPath = path.join(THUMBNAILS_DIR, `${videoId}.jpg`);
      
      try {
        if (fs.existsSync(thumbnailPath)) {
          // 檢查是否還有其他檔案使用這個縮圖
          const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(file => !file.startsWith('.')); // 排除隱藏檔案
          
          const stillUsed = files.some(file => file.includes(`[${videoId}_`));
          
          if (!stillUsed) {
            fs.unlinkSync(thumbnailPath);
            console.log(`✓ 已刪除縮圖: ${videoId}.jpg`);
          }
        }
      } catch (thumbErr) {
        // 縮圖刪除失敗不影響主檔案刪除，只記錄日誌
        console.warn(`⚠ 縮圖刪除失敗: ${thumbErr.message}`);
      }
    }

    res.json({
      success: true,
      message: '檔案已成功刪除'
    });
  } catch (error) {
    console.error('刪除檔案錯誤:', error);
    res.status(500).json({ error: '刪除失敗，請稍後重試' });
  }
});
app.post('/api/video-info', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return res.status(400).json({ error: 'YouTube URL 不能為空' });
    }

    console.log(`獲取視頻信息: ${url}`);

    const result = await downloadThumbnail(url);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('獲取視頻信息錯誤:', error);
    res.status(500).json({
      error: '無法獲取視頻信息',
      details: error.message
    });
  }
});

// ===== OpenAI API 端點 =====
app.post('/api/ask-teacher', async (req, res) => {
  try {
    const { userMessage, context = [], language = 'zh-Hant' } = req.body;

    // 輸入驗證
    if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
      return res.status(400).json({ error: '用戶訊息不能為空' });
    }

    if (userMessage.length > 500) {
      return res.status(400).json({ error: '訊息過長（最多 500 字）' });
    }

    // 構造母語老師 prompt
    const systemPrompt = createTeacherPrompt(language);
    const conversationHistory = context.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    // 使用 OpenAI API
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const teacherResponse = response.data.choices[0].message.content;

    res.json({
      success: true,
      teacherResponse
    });

  } catch (error) {
    console.error('API 錯誤:', error.response?.data || error.message);

    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'API key 無效或已過期' });
    }

    res.status(500).json({
      error: error.response?.data?.error?.message || '伺服器錯誤，請稍後重試'
    });
  }
});

// ===== 獲取相關子主題 =====
app.post('/api/get-subtopics', async (req, res) => {
  try {
    const { topic, language = 'zh-Hant' } = req.body;

    if (!topic) {
      return res.status(400).json({ error: '主題不能為空' });
    }

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `你是一個英文教育專家。提供 3-5 個相關的子主題，以 JSON 格式返回：
            { "subtopics": ["子主題1", "子主題2", ...] }
            語言：${language}`
          },
          {
            role: 'user',
            content: `為「${topic}」這個主題提供相關的子主題，用於英語學習討論。`
          }
        ],
        temperature: 0.7,
        max_tokens: 200
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const content = response.data.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const subtopics = jsonMatch ? JSON.parse(jsonMatch[0]) : { subtopics: [] };

    res.json(subtopics);

  } catch (error) {
    console.error('子主題 API 錯誤:', error.message);
    res.status(500).json({ error: '無法獲取子主題' });
  }
});

// ===== 語法檢查 =====
app.post('/api/check-grammar', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: '文本不能為空' });
    }

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `你是一個英文語法助手。分析用戶的英文句子，並以 JSON 格式返回：
            {
              "original": "原始句子",
              "corrected": "修正後的句子",
              "errors": [{"type": "錯誤類型", "explanation": "解釋"}],
              "nativeVersion": "自然母語表達方式"
            }`
          },
          {
            role: 'user',
            content: `請檢查這個句子的語法：「${text}」`
          }
        ],
        temperature: 0.3,
        max_tokens: 300
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const content = response.data.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    res.json(analysis);

  } catch (error) {
    console.error('語法檢查錯誤:', error.message);
    res.status(500).json({ error: '語法檢查失敗' });
  }
});

// ===== 工具函數 =====
function createTeacherPrompt(language = 'zh-Hant') {
  return `你是一個經驗豐富的英文母語教師。你的角色是：

1. **主要職責**：
   - 用自然、友善的英文與學生互動（英文回覆）
   - 瞭解學生的英文水平，並給予適當的建議
   - 鼓勵學生開口說英文，提升他們的信心

2. **語法與修正**：
   - 如果學生有語法或拼寫錯誤，請溫和地指出
   - 提供正確的用法示例
   - 解釋為什麼該表達方式更好

3. **提問和延伸**：
   - 提出針對性的跟進問題
   - 幫助學生深入探討話題
   - 引入相關的英文詞彙和表達方式

4. **鼓勵和反饋**：
   - 稱讚學生的進步
   - 提供建設性的反饋
   - 推薦相關的學習方向

5. **輸出格式**：
   - 先用英文回覆學生
   - 如果學生要求，提供中文${language === 'zh-Hant' ? '繁體' : '簡體'}翻譯
   - 簡潔、清晰、教育性的回覆

請始終保持耐心和鼓勵的態度。`;
}

// 啟動服務器
app.listen(PORT, () => {
  console.log(`✅ 後端服務器運行在 http://localhost:${PORT}`);
  console.log(`   API 基礎 URL: http://localhost:${PORT}/api/`);
});

// 錯誤處理
process.on('unhandledRejection', (err) => {
  console.error('未捕獲的錯誤:', err);
});