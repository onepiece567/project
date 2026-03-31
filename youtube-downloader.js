const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const axios = require('axios');

const execPromise = util.promisify(exec);

// 確保下載資料夾存在
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const THUMBNAILS_DIR = path.join(__dirname, 'downloads', 'thumbnails');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

/**
 * 下載 YouTube 影片
 * @param {string} videoUrl - YouTube 影片 URL
 * @param {string} format - 下載格式 ('best', 'audio', 'video') 
 * @returns {Promise<Object>} 下載結果
 */
async function downloadYoutubeVideo(videoUrl, format = 'best') {
  try {
    // 驗證 URL
    if (!isValidYoutubeUrl(videoUrl)) {
      throw new Error('無效的 YouTube URL');
    }

    // 清理 URL - 移除播放清單參數以只下載單個影片
    const cleanUrl = videoUrl.split('&list=')[0].split('?list=')[0];

    // 提取視頻 ID 確保唯一檔名
    const videoIdMatch = cleanUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&?]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : Date.now().toString();

    // 生成輸出檔名 - 使用視頻 ID 和格式標識
    const timestamp = Date.now();
    const formatLabel = format === 'audio' ? 'audio' : format === 'video' ? 'video' : 'best';
    const outputTemplate = path.join(DOWNLOADS_DIR, `%(title)s_[${videoId}_${timestamp}]`);

    let command;

    // 使用 yt-dlp（如果已安裝）或 youtube-dl
    const downloadTool = await checkDownloadTool();
    if (!downloadTool) {
      throw new Error('未找到 yt-dlp 或 youtube-dl。請先安裝：pip install yt-dlp');
    }

    // 根據格式選擇下載參數
    // 重要：添加 --no-playlist 確保只下載單個影片
    switch (format) {
      case 'audio':
        command = `${downloadTool} --no-playlist -x --audio-format mp3 --output "${outputTemplate}.%(ext)s" "${cleanUrl}"`;
        break;
      case 'video':
        command = `${downloadTool} --no-playlist -f "bestvideo+bestaudio/best" --output "${outputTemplate}.%(ext)s" "${cleanUrl}"`;
        break;
      case 'best':
      default:
        command = `${downloadTool} --no-playlist -f "best" --output "${outputTemplate}.%(ext)s" "${cleanUrl}"`;
        break;
    }

    console.log(`執行命令: ${command}`);
    
    const { stdout, stderr } = await execPromise(command, { 
      timeout: 600000, // 10 分鐘超時
      maxBuffer: 10 * 1024 * 1024 // 10MB 緩衝
    });

    console.log('下載完成:', stdout);

    // 查找下載的檔案 - 根據新的命名規則
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const searchPattern = `_[${videoId}_${timestamp}]`;
    
    const downloadedFile = files
      .filter(file => file.includes(searchPattern))
      .map(file => ({
        name: file,
        path: path.join(DOWNLOADS_DIR, file),
        size: fs.statSync(path.join(DOWNLOADS_DIR, file)).size
      }))[0];

    if (!downloadedFile) {
      throw new Error('檔案下載後遺失。搜尋模式: ' + searchPattern);
    }

    // 確保官方縮圖已下載（使用相同的 downloadThumbnail 邏輯）
    console.log('確保官方縮圖已下載...');
    const thumbnailResult = await downloadThumbnail(cleanUrl);
    
    if (!thumbnailResult.success) {
      console.warn('⚠ 官方縮圖下載失敗:', thumbnailResult.error);
    } else {
      console.log('✓ 官方縮圖已確認:', thumbnailResult.thumbnailUrl);
    }

    // 使用官方縮圖作為 frameUrl
    const frameUrl = thumbnailResult.success ? thumbnailResult.thumbnailUrl : '';

    return {
      success: true,
      message: '下載成功',
      file: {
        name: downloadedFile.name,
        size: downloadedFile.size,
        sizeFormatted: formatFileSize(downloadedFile.size),
        path: downloadedFile.path,
        downloadUrl: `/download/${downloadedFile.name}`,
        frameUrl: frameUrl,
        videoId: videoId
      }
    };

  } catch (error) {
    console.error('下載錯誤:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 檢驗 YouTube URL
 */
function isValidYoutubeUrl(url) {
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)\//;
  return youtubeRegex.test(url);
}

/**
 * 檢查下載工具是否可用
 */
async function checkDownloadTool() {
  try {
    // 檢查虛擬環境中的 yt-dlp
    const venvPath = path.join(__dirname, '.venv', 'Scripts', 'yt-dlp');
    await execPromise(`${venvPath} --version`);
    return venvPath;
  } catch (error) {
    try {
      // 先檢查系統 yt-dlp
      await execPromise('yt-dlp --version');
      return 'yt-dlp';
    } catch (error) {
      try {
        // 再檢查 youtube-dl
        await execPromise('youtube-dl --version');
        return 'youtube-dl';
      } catch (error) {
        return null;
      }
    }
  }
}

/**
 * 格式化檔案大小
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * 清理舊檔案 (30 天以上)
 */
async function cleanupOldFiles() {
  try {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    fs.readdirSync(DOWNLOADS_DIR).forEach(file => {
      const filePath = path.join(DOWNLOADS_DIR, file);
      const stats = fs.statSync(filePath);
      
      if (stats.mtimeMs < thirtyDaysAgo) {
        fs.unlinkSync(filePath);
        console.log(`已刪除舊檔案: ${file}`);
      }
    });
  } catch (error) {
    console.error('清理檔案錯誤:', error);
  }
}

/**
 * 獲取 YouTube 視頻信息
 */
async function getVideoInfo(videoUrl) {
  try {
    const cleanUrl = videoUrl.split('&list=')[0].split('?list=')[0];
    
    const downloadTool = await checkDownloadTool();
    if (!downloadTool) {
      throw new Error('未找到 yt-dlp');
    }

    // 使用 yt-dlp 獲取視頻信息
    const { stdout } = await execPromise(
      `${downloadTool} --dump-json --no-warnings "${cleanUrl}"`,
      { timeout: 30000, maxBuffer: 50 * 1024 * 1024 }
    );

    const videoInfo = JSON.parse(stdout);
    
    // 構建最佳品質縮圖 URL（YouTube 提供多個縮圖選項）
    // 優先級: sddefault > hqdefault > mqdefault > default
    const videoId = videoInfo.id || '';
    let thumbnailUrl = videoInfo.thumbnail || '';
    if (videoId) {
      // 使用 sddefault（超高品質）或 hqdefault（高品質）
      thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`;
    }

    return {
      success: true,
      title: videoInfo.title || '未知標題',
      duration: videoInfo.duration || 0,
      thumbnail: thumbnailUrl,
      description: videoInfo.description || '',
      uploader: videoInfo.uploader || '未知上傳者',
      uploadDate: videoInfo.upload_date || '',
      viewCount: videoInfo.view_count || 0,
      videoId: videoId
    };
  } catch (error) {
    console.error('獲取視頻信息錯誤:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 下載視頻縮圖
 */
async function downloadThumbnail(videoUrl) {
  try {
    const videoInfo = await getVideoInfo(videoUrl);
    
    if (!videoInfo.success) {
      throw new Error(videoInfo.error);
    }

    const videoId = videoInfo.videoId;
    const thumbnailPath = path.join(THUMBNAILS_DIR, `${videoId}.jpg`);

    // 如果縮圖已存在，直接返回
    if (fs.existsSync(thumbnailPath)) {
      const currentSize = fs.statSync(thumbnailPath).size;
      console.log(`✓ 縮圖已存在 (${videoId}.jpg): ${currentSize} 字元，使用快取`);
      return {
        success: true,
        thumbnailUrl: `/downloads/thumbnails/${videoId}.jpg`,
        ...videoInfo
      };
    }

    // 下載縮圖
    console.log(`📥 開始下載官方縮圖: ${videoInfo.thumbnail}`);
    if (videoInfo.thumbnail) {
      const axios = require('axios');
      const response = await axios.get(videoInfo.thumbnail, {
        responseType: 'arraybuffer',
        timeout: 10000
      });
      
      console.log(`✓ 縮圖已下載 (${response.data.length} 字元)`);
      fs.writeFileSync(thumbnailPath, response.data);
    }

    return {
      success: true,
      thumbnailUrl: `/downloads/thumbnails/${videoId}.jpg`,
      ...videoInfo
    };
  } catch (error) {
    console.error('下載縮圖錯誤:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 提取視頻幀 - 使用簡單的方式
 */
/**
 * 獲取視頻時長（秒）
 */
async function getVideoDuration(videoPath) {
  try {
    const ffmpegPath = await checkFFmpeg();
    if (!ffmpegPath) return null;

    const { stderr } = await execPromise(`"${ffmpegPath}" -i "${videoPath}" 2>&1`, { maxBuffer: 10 * 1024 * 1024 }).catch(err => {
      // FFmpeg 總是將輸出發送到 stderr，即使成功也會返回 error 對象
      return { stderr: err.stderr || err.stdout || '' };
    });
    
    const match = (stderr || '').match(/Duration: (\d+):(\d+):(\d+(\.\d+)?)/);
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      const seconds = parseFloat(match[3]);
      const duration = hours * 3600 + minutes * 60 + seconds;
      console.log(`✓ 獲取視頻時長: ${Math.floor(duration)} 秒`);
      return duration;
    }
  } catch (err) {
    console.warn('獲取視頻時長失敗（非致命）:', err.message);
  }
  return null;
}

async function extractVideoFrame(videoPath, skipSeconds = null) {
  try {
    const basename = path.basename(videoPath, path.extname(videoPath));
    const framePath = path.join(THUMBNAILS_DIR, `frame_${basename}_${Date.now()}.jpg`);

    // 嘗試找到 FFmpeg
    const ffmpegPath = await checkFFmpeg();
    if (!ffmpegPath) {
      console.warn('FFmpeg 未安裝');
      return {
        success: false,
        error: 'FFmpeg 未安裝'
      };
    }

    // 對於音頻文件，不提取幀
    if (videoPath.endsWith('.mp3') || videoPath.endsWith('.m4a')) {
      return {
        success: true,
        framePath: null,
        frameUrl: null
      };
    }

    // 獲取視頻時長，以確定合適的提取時間
    let extractTime = skipSeconds;
    const videoDuration = await getVideoDuration(videoPath);
    
    if (videoDuration) {
      console.log(`視頻時長: ${Math.floor(videoDuration)} 秒`);
      
      // 智能計算提取時間，避免片頭曲
      if (videoDuration < 30) {
        // 短視頻：跳過前 5 秒（片頭曲通常 3-5 秒）
        extractTime = Math.max(5, videoDuration * 0.2);
      } else if (videoDuration < 300) {
        // 中等長度視頻（5-300秒）：提取 1/3 位置
        extractTime = Math.floor(videoDuration / 3);
      } else {
        // 長視頻（>5分鐘）：提取 1/4 位置
        extractTime = Math.floor(videoDuration / 4);
      }
      
      console.log(`智能計算提取時間: ${Math.floor(extractTime)} 秒 (避免片頭曲)`);
    } else if (skipSeconds === null) {
      // 如果無法獲取時長且沒有指定時間，默認提取 10 秒
      extractTime = 10;
      console.log(`使用默認提取時間: ${extractTime} 秒`);
    }

    // 使用 FFmpeg 提取指定時間的幀
    const command = `"${ffmpegPath}" -i "${videoPath}" -ss ${extractTime} -vframes 1 -q:v 2 -pix_fmt yuvj420p -update 1 "${framePath}" -y`;
    
    console.log(`提取視頻幀 (時間: ${Math.floor(extractTime)}s)...`);
    try {
      const { stdout, stderr } = await execPromise(command, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
      console.log('✓ FFmpeg 幀提取完成');
    } catch (err) {
      // 嘗試改用 PNG 格式
      console.warn('⚠ JPG 幀提取失敗，嘗試 PNG...');
      
      const pngPath = framePath.replace('.jpg', '.png');
      const backupCommand = `"${ffmpegPath}" -i "${videoPath}" -ss ${extractTime} -vframes 1 -pix_fmt rgb24 "${pngPath}" -y`;
      try {
        await execPromise(backupCommand, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
        // 如果 PNG 成功，就用它代替 JPG
        if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) {
          try {
            fs.renameSync(pngPath, framePath);
            console.log('✓ 已轉換 PNG 為 JPG');
          } catch (renameErr) {
            // PNG 也可以用，直接改副檔名
            const jpgPath = pngPath.replace('.png', '.jpg');
            fs.renameSync(pngPath, jpgPath);
            return {
              success: true,
              framePath: jpgPath,
              frameUrl: `/downloads/thumbnails/${path.basename(jpgPath)}`
            };
          }
        }
      } catch (backupErr) {
        console.error('備選幀提取方案也失敗:', backupErr.message);
      }
    }

    // 檢查文件是否成功創建
    if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
      const fileSize = fs.statSync(framePath).size;
      console.log(`✓ 成功提取視頻幀 (${(fileSize / 1024).toFixed(2)} KB) -> ${path.basename(framePath)}`);
      return {
        success: true,
        framePath: framePath,
        frameUrl: `/downloads/thumbnails/${path.basename(framePath)}`
      };
    }

    console.warn('⚠ 無法提取視頻幀');
    return {
      success: false,
      error: '無法提取視頻幀'
    };
  } catch (error) {
    console.error('提取視頻幀異常:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 檢查 FFmpeg 是否可用
 */
async function checkFFmpeg() {
  const possiblePaths = [
    'ffmpeg',
    'C:\\ffmpeg\\ffmpeg.exe',
    'C:\\Program Files\\FFmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files (x86)\\FFmpeg\\bin\\ffmpeg.exe',
    path.join(process.env.PROGRAMFILES, 'FFmpeg', 'bin', 'ffmpeg.exe')
  ];

  for (const ffmpegPath of possiblePaths) {
    try {
      await execPromise(`"${ffmpegPath}" -version`, { timeout: 5000 });
      console.log('找到 FFmpeg:', ffmpegPath);
      return ffmpegPath;
    } catch (error) {
      // 繼續嘗試下一個路徑
    }
  }

  console.warn('未找到 FFmpeg');
  return null;
}

/**
 * 獲取下載資料夾中的檔案列表
 */
function getDownloadedFiles() {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(file => file !== 'thumbnails' && !file.endsWith('.json')); // 過濾掉縮圖資料夾和元數據文件
    
    const thumbnailFiles = fs.existsSync(THUMBNAILS_DIR) 
      ? fs.readdirSync(THUMBNAILS_DIR).filter(f => !f.startsWith('frame_'))
      : [];
    
    return files.map(file => {
      // 從文件名中提取 videoId
      // 格式: title_[videoId_timestamp].ext
      const videoIdMatch = file.match(/\[([a-zA-Z0-9_-]+)_\d+\]/);
      const videoId = videoIdMatch ? videoIdMatch[1] : '';
      
      // 查找對應的官方縮圖（按 videoId 匹配）
      let thumbnailUrl = null;
      if (videoId) {
        const thumbnailFile = `${videoId}.jpg`;
        if (thumbnailFiles.includes(thumbnailFile)) {
          thumbnailUrl = `/downloads/thumbnails/${thumbnailFile}`;
        }
      }
      
      return {
        name: file,
        size: fs.statSync(path.join(DOWNLOADS_DIR, file)).size,
        sizeFormatted: formatFileSize(fs.statSync(path.join(DOWNLOADS_DIR, file)).size),
        downloadUrl: `/download/${file}`,
        frameUrl: thumbnailUrl, // 官方縮圖
        videoId: videoId
      };
    });
  } catch (error) {
    console.error('獲取檔案列表錯誤:', error);
    return [];
  }
}

// 每 24 小時執行一次清理
setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000);

module.exports = {
  downloadYoutubeVideo,
  getVideoInfo,
  downloadThumbnail,
  extractVideoFrame,
  checkFFmpeg,
  DOWNLOADS_DIR,
  THUMBNAILS_DIR,
  getDownloadedFiles,
  cleanupOldFiles
};
