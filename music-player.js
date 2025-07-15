
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const IconManager = require('./icon-manager.js');

class LocalMusicPlayer {
  constructor() {
    this.currentTrack = null;
    this.playlist = [];
    this.currentIndex = 0;
    this.isPlaying = false;
    this.isPaused = false;
    this.volume = 50;
    this.loop = false;
    this.shuffle = false;
    this.originalPlaylist = [];
    this.audioPlayer = null;
    this.customPlaylists = new Map(); // Store custom user playlists
    this.startTime = null; // Track when song started
    this.pausedTime = 0; // Time spent paused
    this.iconManager = new IconManager(); // Custom icon management
    this.musicFolders = [
      './music',
      './songs',
      './audio',
      process.env.MUSIC_FOLDER || './music'
    ];
    this.supportedFormats = ['.mp3', '.wav', '.ogg', '.m4a', '.flac'];
    this.initializeMusicFolders();
    this.loadCustomPlaylists();
  }

  initializeMusicFolders() {
    this.musicFolders.forEach(folder => {
      if (!fs.existsSync(folder)) {
        try {
          fs.mkdirSync(folder, { recursive: true });
          console.log(`📁 Created music folder: ${folder}`);
        } catch (error) {
          console.error(`Failed to create music folder ${folder}:`, error);
        }
      }
    });
  }

  scanForMusic() {
    const musicFiles = [];

    this.musicFolders.forEach(folder => {
      if (fs.existsSync(folder)) {
        try {
          const files = fs.readdirSync(folder, { withFileTypes: true });
          files.forEach(file => {
            if (file.isFile()) {
              const ext = path.extname(file.name).toLowerCase();
              if (this.supportedFormats.includes(ext)) {
                const fullPath = path.join(folder, file.name);
                const stats = fs.statSync(fullPath);
                musicFiles.push({
                  name: path.basename(file.name, ext),
                  filename: file.name,
                  path: fullPath,
                  size: stats.size,
                  extension: ext,
                  folder: folder,
                  duration: this.estimateDuration(stats.size, ext)
                });
              }
            }
          });
        } catch (error) {
          console.error(`Error scanning folder ${folder}:`, error);
        }
      }
    });

    return musicFiles;
  }

  estimateDuration(fileSize, extension) {
    // Rough estimation based on file size and format
    const avgBitrate = extension === '.mp3' ? 128000 : 
                      extension === '.wav' ? 1411200 : 
                      extension === '.flac' ? 1000000 : 128000;

    const durationSeconds = Math.floor((fileSize * 8) / avgBitrate);
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  loadPlaylist(searchQuery = null, playlistType = 'all') {
    const musicFiles = this.scanForMusic();
    let filteredFiles = musicFiles;

    // Apply playlist type filtering
    switch (playlistType) {
      case 'tamil':
        filteredFiles = musicFiles.filter(file => 
          /[\u0B80-\u0BFF]/.test(file.name) || // Tamil Unicode range
          this.isTamilSong(file.name)
        );
        break;
      case 'english':
        filteredFiles = musicFiles.filter(file => 
          !/[\u0B80-\u0BFF]/.test(file.name) && // Not Tamil
          /^[a-zA-Z0-9\s\-\_\(\)\[\]\.]+$/.test(file.name)
        );
        break;
      case 'rock':
        filteredFiles = musicFiles.filter(file => 
          this.isRockSong(file.name)
        );
        break;
      case 'movies':
        filteredFiles = musicFiles.filter(file => 
          this.isMovieSong(file.name)
        );
        break;
      case 'favorites_ak':
        filteredFiles = musicFiles.filter(file => 
          /^[A-K]/i.test(file.name)
        );
        break;
      case 'favorites_lz':
        filteredFiles = musicFiles.filter(file => 
          /^[L-Z]/i.test(file.name)
        );
        break;
      case 'shuffle':
        filteredFiles = musicFiles;
        this.shuffle = true;
        break;
      default:
        filteredFiles = musicFiles;
        break;
    }

    if (searchQuery) {
      filteredFiles = filteredFiles.filter(file => 
        file.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        file.filename.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    this.playlist = filteredFiles;
    this.originalPlaylist = [...this.playlist];

    if (this.shuffle) {
      this.shufflePlaylist();
    }

    return this.playlist;
  }

  isTamilSong(filename) {
    const tamilKeywords = [
      'tamil', 'kollywood', 'ilayaraja', 'rahman', 'anirudh', 'harris', 'yuvan',
      'dhanush', 'vijay', 'ajith', 'rajini', 'kamal', 'suriya', 'karthi',
      'sivakarthikeyan', 'vikram', 'simbu', 'str'
    ];
    return tamilKeywords.some(keyword => 
      filename.toLowerCase().includes(keyword)
    );
  }

  isRockSong(filename) {
    const rockKeywords = [
      'rock', 'metal', 'guitar', 'band', 'electric', 'drums',
      'beatles', 'queen', 'led zeppelin', 'pink floyd', 'acdc'
    ];
    return rockKeywords.some(keyword => 
      filename.toLowerCase().includes(keyword)
    );
  }

  isMovieSong(filename) {
    const movieKeywords = [
      'from', 'theme', 'soundtrack', 'ost', 'bgm', 'background',
      'title track', 'main theme', 'movie', 'film'
    ];
    return movieKeywords.some(keyword => 
      filename.toLowerCase().includes(keyword)
    );
  }

  play(trackIndex = null) {
    if (this.playlist.length === 0) {
      return { success: false, message: 'No tracks in playlist' };
    }

    if (trackIndex !== null) {
      this.currentIndex = Math.max(0, Math.min(trackIndex, this.playlist.length - 1));
    }

    this.currentTrack = this.playlist[this.currentIndex];
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = Date.now();
    this.pausedTime = 0;

    console.log(`🎵 Music player state: Playing "${this.currentTrack.name}" (isPlaying: ${this.isPlaying}, isPaused: ${this.isPaused})`);

    return { 
      success: true, 
      track: this.currentTrack,
      message: `Now playing: ${this.currentTrack.name}`
    };
  }

  pause() {
    if (!this.isPlaying) {
      return { success: false, message: 'No track is playing' };
    }

    if (!this.isPaused) {
      // Pausing
      this.pausedTime += Date.now() - this.startTime;
    } else {
      // Resuming
      this.startTime = Date.now();
    }

    this.isPaused = !this.isPaused;
    return { 
      success: true, 
      message: this.isPaused ? 'Paused' : 'Resumed',
      paused: this.isPaused
    };
  }

  next() {
    return this.nextTrack();
  }

  previous() {
    if (this.playlist.length === 0) {
      return { success: false, message: 'No tracks in playlist' };
    }

    if (this.currentIndex === 0) {
      this.currentIndex = this.playlist.length - 1;
    } else {
      this.currentIndex--;
    }

    this.currentTrack = this.playlist[this.currentIndex];
    this.resetProgress(); // Reset progress for new track
    return this.play();
  }

  setVolume(level) {
    this.volume = Math.max(0, Math.min(100, level));
    return { 
      success: true, 
      volume: this.volume,
      message: `Volume set to ${this.volume}%`
    };
  }

  volumeUp() {
    return this.setVolume(this.volume + 10);
  }

  volumeDown() {
    return this.setVolume(this.volume - 10);
  }

  toggleLoop() {
    this.loop = !this.loop;
    return { 
      success: true, 
      loop: this.loop,
      message: `Loop ${this.loop ? 'enabled' : 'disabled'}`
    };
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;

    if (this.shuffle) {
      this.shufflePlaylist();
    } else {
      this.playlist = [...this.originalPlaylist];
      // Find current track position in original playlist
      const currentTrackPath = this.currentTrack?.path;
      if (currentTrackPath) {
        this.currentIndex = this.playlist.findIndex(track => track.path === currentTrackPath);
      }
    }

    return { 
      success: true, 
      shuffle: this.shuffle,
      message: `Shuffle ${this.shuffle ? 'enabled' : 'disabled'}`
    };
  }

  shufflePlaylist() {
    const currentTrackPath = this.currentTrack?.path;

    // Fisher-Yates shuffle algorithm
    for (let i = this.playlist.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.playlist[i], this.playlist[j]] = [this.playlist[j], this.playlist[i]];
    }

    // Find new position of current track
    if (currentTrackPath) {
      this.currentIndex = this.playlist.findIndex(track => track.path === currentTrackPath);
    }
  }

  resetProgress() {
    this.startTime = Date.now();
    this.pausedTime = 0;
  }

  getTotalDuration() {
    if (this.playlist.length === 0) return '0:00';
    
    let totalSeconds = 0;
    this.playlist.forEach(track => {
      const [minutes, seconds] = track.duration.split(':').map(Number);
      totalSeconds += minutes * 60 + seconds;
    });

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  getNowPlayingWidget() {
    if (!this.currentTrack) {
      return new EmbedBuilder()
        .setColor(0x2C2F33)
        .setTitle('🎵 Local Music Player')
        .setDescription('```\n┌─────────────────────────────────────┐\n│           🎵 MUSIC PLAYER          │\n│              [ IDLE ]               │\n├─────────────────────────────────────┤\n│  Status: ⏹️ Stopped                │\n│  Library: ' + `${this.playlist.length}`.padEnd(17) + ' tracks      │\n│  Volume: ' + `${this.volume}%`.padEnd(18) + '       │\n│  Loop: ' + `${this.loop ? '✅ ON' : '❌ OFF'}`.padEnd(20) + '     │\n│  Shuffle: ' + `${this.shuffle ? '✅ ON' : '❌ OFF'}`.padEnd(17) + '    │\n└─────────────────────────────────────┘\n```\n\n**🎮 Quick Start Options:**\n🎵 `/localplay` - Start playing music\n📝 `/localplaylist-play` - Browse playlists\n📊 `/localstats` - View statistics\n🔀 `/localshuffle` - Enable shuffle mode')
        .addFields(
          { name: '📀 Total Duration', value: this.getTotalDuration(), inline: true },
          { name: '🎵 Available Playlists', value: 'Tamil, English, Rock, Movies & Custom', inline: true },
          { name: '📱 Touch Controls', value: 'Use circular buttons below ⭕', inline: true }
        )
        .setFooter({ text: 'Local Music Player • Ready to play your music!' })
        .setTimestamp();
    }

    // Use actual audio player state if available
    const actuallyPlaying = this.isActuallyPlaying();
    const actuallyPaused = this.isActuallyPaused();
    const progress = this.getCurrentProgress();

    const statusIcon = actuallyPaused ? '⏸️' : actuallyPlaying ? '▶️' : this.isPlaying ? '🔄' : '⏹️';
    const statusText = actuallyPaused ? 'Paused' : actuallyPlaying ? 'Playing' : this.isPlaying ? 'Loading' : 'Stopped';

    // Create a visual rectangle player display
    const playerDisplay = `\`\`\`\n┌─────────────────────────────────────┐\n│           🎵 MUSIC PLAYER          │\n│          ${statusIcon} ${statusText.toUpperCase().padEnd(9)}          │\n├─────────────────────────────────────┤\n│ Track: ${this.currentTrack.name.substring(0, 25).padEnd(25)}  │\n│ Progress: ${progress.current} / ${progress.total}         │\n│ ${progress.progressBar} │\n│ Completion: ${progress.percentage}%${' '.repeat(24 - progress.percentage.toString().length)} │\n├─────────────────────────────────────┤\n│ Position: ${(this.currentIndex + 1).toString().padStart(3)}/${this.playlist.length.toString().padEnd(3)} Volume: ${this.volume.toString().padStart(3)}% │\n│ Loop: ${this.loop ? '✅ ON' : '❌ OFF'}  Shuffle: ${this.shuffle ? '✅ ON' : '❌ OFF'} │\n└─────────────────────────────────────┘\n\`\`\``;

    return new EmbedBuilder()
      .setColor(actuallyPlaying || this.isPlaying ? 0x1DB954 : actuallyPaused ? 0xFFA500 : 0x636363)
      .setTitle('🎵 Local Music Player - Rectangle Display')
      .setDescription(playerDisplay + '\n\n**📱 Use the circular buttons below to control playback:**')
      .addFields(
        { name: '🎵 Track Info', value: `**${this.currentTrack.name}**\nFormat: ${this.currentTrack.extension.toUpperCase()} • Size: ${(this.currentTrack.size / 1024 / 1024).toFixed(2)} MB`, inline: false },
        { name: '📁 File Location', value: `\`${path.basename(this.currentTrack.folder)}\``, inline: true },
        { name: '⏱️ Duration', value: this.currentTrack.duration, inline: true },
        { name: '📊 Status', value: `${statusIcon} ${statusText}`, inline: true }
      )
      .setFooter({ 
        text: `Local Music Player • Rectangle Widget • ${this.playlist.length} tracks loaded`,
        iconURL: 'https://cdn.discordapp.com/emojis/852881704776146954.gif'
      })
      .setTimestamp();
  }

  getPlayerButtons() {
    const actuallyPlaying = this.isActuallyPlaying();
    const actuallyPaused = this.isActuallyPaused();

    // Row 1: Main playback controls (circular buttons)
    const playbackRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_previous')
          .setEmoji('⏮️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(this.currentIndex === 0 && !this.loop),
        new ButtonBuilder()
          .setCustomId('music_playpause')
          .setEmoji(actuallyPaused || this.isPaused ? '▶️' : '⏸️')
          .setStyle(actuallyPaused || this.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('music_next')
          .setEmoji('⏭️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!this.hasNextTrack())
      );

    // Row 2: Volume controls (circular buttons)
    const volumeRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_volume_down')
          .setEmoji('🔉')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(this.volume <= 0),
        new ButtonBuilder()
          .setCustomId('music_volume_info')
          .setLabel(`${this.volume}%`)
          .setEmoji('🔊')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('music_volume_up')
          .setEmoji('🔊')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(this.volume >= 100)
      );

    // Row 3: Mode controls (circular buttons)
    const modeRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_loop')
          .setEmoji('🔁')
          .setStyle(this.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_shuffle')
          .setEmoji('🔀')
          .setStyle(this.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_refresh')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary)
      );

    return [playbackRow, volumeRow, modeRow];
  }

  getIdlePlayerButtons() {
    const playbackRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_start_playing')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('music_show_playlist')
          .setEmoji('📝')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('music_show_stats')
          .setEmoji('📊')
          .setStyle(ButtonStyle.Secondary)
      );

    return [playbackRow];
  }

  getEnhancedCustomIdlePlayerButtons() {
    // Premium idle controls with enhanced styling
    const mainRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_play_custom')
          .setLabel('My Playlists')
          .setEmoji('📝')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('music_start_custom_local')
          .setLabel('Start Playing')
          .setEmoji('🎵')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('music_create_new_playlist')
          .setLabel('Create Playlist')
          .setEmoji('✨')
          .setStyle(ButtonStyle.Secondary)
      );

    const utilityRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_shuffle_all')
          .setLabel('Shuffle Mode')
          .setEmoji('🔀')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_view_library_stats')
          .setLabel('Library Stats')
          .setEmoji('📊')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_settings_menu')
          .setLabel('Settings')
          .setEmoji('⚙️')
          .setStyle(ButtonStyle.Secondary)
      );

    return [mainRow, utilityRow];
  }

  getCompactIdlePlayerButtons() {
    const compactRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_start_custom_local')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('music_play_custom')
          .setEmoji('📝')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('music_shuffle_all')
          .setEmoji('🔀')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_refresh_widget')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary)
      );

    return [compactRow];
  }

  getCompactPlayerButtons() {
    const actuallyPlaying = this.isActuallyPlaying();
    const actuallyPaused = this.isActuallyPaused();

    // Single row with all essential controls
    const controlRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_previous')
          .setEmoji('⏮️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_playpause')
          .setEmoji(actuallyPaused || this.isPaused ? '▶️' : '⏸️')
          .setStyle(actuallyPaused || this.isPaused ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('music_next')
          .setEmoji('⏭️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_volume_down')
          .setEmoji('🔉')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_volume_up')
          .setEmoji('🔊')
          .setStyle(ButtonStyle.Secondary)
      );

    // Second row with modes and utilities
    const modeRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_loop')
          .setEmoji('🔁')
          .setStyle(this.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_shuffle')
          .setEmoji('🔀')
          .setStyle(this.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_stop_and_clear')
          .setEmoji('⏹️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('music_refresh_widget')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary)
      );

    return [controlRow, modeRow];
  }

  getCustomIdlePlayerButtons() {
    const playbackRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_play_custom')
          .setEmoji('📝')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('music_start_custom_local')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('music_create_new_playlist')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Secondary)
      );

    return [playbackRow];
  }

  getEnhancedCustomPlayerButtons() {
    const actuallyPlaying = this.isActuallyPlaying();
    const actuallyPaused = this.isActuallyPaused();

    // Row 1: Premium playback controls with Unicode emojis (custom icons shown in embed)
    const playbackRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_previous')
          .setLabel('Previous')
          .setEmoji('⏮️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_playpause')
          .setLabel(actuallyPaused || this.isPaused ? 'Play' : 'Pause')
          .setEmoji(actuallyPaused || this.isPaused ? '▶️' : '⏸️')
          .setStyle(actuallyPaused || this.isPaused ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('music_next')
          .setLabel('Next')
          .setEmoji('⏭️')
          .setStyle(ButtonStyle.Secondary)
      );

    // Row 2: Volume and playlist controls with Unicode emojis
    const volumeRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_volume_down')
          .setLabel('Vol -')
          .setEmoji('🔉')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_add_to_playlist')
          .setLabel('Add to Playlist')
          .setEmoji('💜')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('music_volume_up')
          .setLabel('Vol +')
          .setEmoji('🔊')
          .setStyle(ButtonStyle.Secondary)
      );

    // Row 3: Enhanced mode controls with Unicode emojis
    const modeRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_loop')
          .setLabel(this.loop ? 'Loop ON' : 'Loop OFF')
          .setEmoji('🔁')
          .setStyle(this.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_show_track_info')
          .setLabel('Track Info')
          .setEmoji('📋')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_shuffle')
          .setLabel(this.shuffle ? 'Shuffle ON' : 'Shuffle OFF')
          .setEmoji('🔀')
          .setStyle(this.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary)
      );

    // Row 4: Additional controls with Unicode emojis
    const extraRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_stop_and_clear')
          .setLabel('Stop')
          .setEmoji('⏹️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('music_refresh_widget')
          .setLabel('Refresh')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_browse_custom_playlists')
          .setLabel('Browse Playlists')
          .setEmoji('📚')
          .setStyle(ButtonStyle.Primary)
      );

    return [playbackRow, volumeRow, modeRow, extraRow];
  }

  getCustomPlayerButtons() {
    const actuallyPlaying = this.isActuallyPlaying();
    const actuallyPaused = this.isActuallyPaused();

    // Row 1: Main playback controls
    const playbackRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_previous')
          .setEmoji('⏮️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_playpause')
          .setEmoji(actuallyPaused || this.isPaused ? '▶️' : '⏸️')
          .setStyle(actuallyPaused || this.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('music_next')
          .setEmoji('⏭️')
          .setStyle(ButtonStyle.Secondary)
      );

    // Row 2: Volume and settings
    const volumeRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_volume_down')
          .setEmoji('🔉')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_add_to_custom_playlist')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_volume_up')
          .setEmoji('🔊')
          .setStyle(ButtonStyle.Secondary)
      );

    // Row 3: Mode controls
    const modeRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('music_loop')
          .setEmoji('🔁')
          .setStyle(this.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_refresh_widget')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music_shuffle')
          .setEmoji('🔀')
          .setStyle(this.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary)
      );

    return [playbackRow, volumeRow, modeRow];
  }

  getPlaylistEmbed(page = 1, itemsPerPage = 10) {
    if (this.playlist.length === 0) {
      return new EmbedBuilder()
        .setColor(0x636363)
        .setTitle('🎵 Playlist')
        .setDescription('No tracks found. Add music files to your music folders!\n\n**🎮 Quick Actions:**\n🔄 `/localplay` - Load and play music\n📊 `/localstats` - View player statistics\n📁 Check your music folders below')
        .addFields(
          { name: '📁 Music Folders', value: this.musicFolders.map(folder => `\`${folder}\``).join('\n'), inline: false },
          { name: '🎵 Supported Formats', value: this.supportedFormats.join(', '), inline: false }
        );
    }

    const totalPages = Math.ceil(this.playlist.length / itemsPerPage);
    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, this.playlist.length);

    const trackList = this.playlist.slice(startIndex, endIndex).map((track, index) => {
      const globalIndex = startIndex + index;
      const isCurrentTrack = globalIndex === this.currentIndex;
      const prefix = isCurrentTrack ? '🎵 ' : '🎶 ';
      const playCommand = `/localplay track:${globalIndex + 1}`;
      return `${prefix}${globalIndex + 1}. **${track.name}** (${track.duration})\n   \`${playCommand}\` - Play this track`;
    }).join('\n\n');

    const controls = [
      `🎵 \`/localplay track:NUMBER\` - Play specific track`,
      `🔀 \`/localshuffle\` - Toggle shuffle mode`,
      `📄 \`/localplaylist ${page + 1}\` - Next page`,
      `🔍 \`/localplay search:QUERY\` - Search tracks`
    ];

    return new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('🎵 Music Playlist')
      .setDescription(`${trackList}\n\n**🎮 Playlist Controls:**\n${controls.join('\n')}`)
      .addFields(
        { name: '📊 Total Tracks', value: this.playlist.length.toString(), inline: true },
        { name: '📄 Current Page', value: `${page}/${totalPages}`, inline: true },
        { name: '🔀 Shuffle', value: this.shuffle ? '✅ On' : '❌ Off', inline: true }
      )
      .setFooter({ text: 'Local Music Player • Use commands above to control playback' })
      .setTimestamp();
  }

  getPlayerStats() {
    const totalSize = this.playlist.reduce((sum, track) => sum + track.size, 0);
    const totalSizeGB = (totalSize / 1024 / 1024 / 1024).toFixed(2);

    const formatCounts = {};
    this.playlist.forEach(track => {
      const ext = track.extension.toUpperCase();
      formatCounts[ext] = (formatCounts[ext] || 0) + 1;
    });

    const formatStats = Object.entries(formatCounts)
      .map(([format, count]) => `${format}: ${count}`)
      .join('\n');

    const quickActions = [
      `🎵 \`/localnowplaying\` - Current track widget`,
      `📝 \`/localplaylist\` - View full playlist`,
      `🎮 \`/localplay\` - Start playing music`,
      `🔊 \`/localvolume set 75\` - Adjust volume`,
      `🔄 \`/localloop\` - Toggle loop mode`,
      `🔀 \`/localshuffle\` - Toggle shuffle`
    ];

    return new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('📊 Music Player Statistics')
      .setDescription(`**🎮 Quick Actions:**\n${quickActions.join('\n')}`)
      .addFields(
        { name: '📊 Total Tracks', value: this.playlist.length.toString(), inline: true },
        { name: '💾 Total Size', value: `${totalSizeGB} GB`, inline: true },
        { name: '🎵 Currently Playing', value: this.currentTrack ? this.currentTrack.name : 'None', inline: true },
        { name: '📁 Format Distribution', value: formatStats || 'No tracks', inline: false },
        { name: '⚙️ Player Settings', value: `🔊 Volume: ${this.volume}%\n🔁 Loop: ${this.loop ? '✅ On' : '❌ Off'}\n🔀 Shuffle: ${this.shuffle ? '✅ On' : '❌ Off'}`, inline: false },
        { name: '📍 Music Folders', value: this.musicFolders.map(folder => `\`${folder}\``).join('\n'), inline: false }
      )
      .setFooter({ text: 'Local Music Player Statistics • Use commands above for quick control' })
      .setTimestamp();
  }

  getCurrentTrack() {
    return this.currentTrack;
  }

  setAudioPlayer(audioPlayer) {
    this.audioPlayer = audioPlayer;
  }

  getAudioPlayer() {
    return this.audioPlayer;
  }

  isActuallyPlaying() {
    if (!this.audioPlayer) return this.isPlaying;
    try {
      const { AudioPlayerStatus } = require('@discordjs/voice');
      return this.audioPlayer.state.status === AudioPlayerStatus.Playing;
    } catch (error) {
      console.log('Error checking audio player status:', error.message);
      return this.isPlaying;
    }
  }

  isActuallyPaused() {
    if (!this.audioPlayer) return this.isPaused;
    try {
      const { AudioPlayerStatus } = require('@discordjs/voice');
      return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
    } catch (error) {
      console.log('Error checking audio player pause status:', error.message);
      return this.isPaused;
    }
  }

  stop() {
    if (this.audioPlayer) {
      this.audioPlayer.stop();
    }
    this.isPlaying = false;
    this.isPaused = false;
    this.currentTrack = null;
    return { success: true, message: 'Playback stopped' };
  }

  nextTrack() {
    if (this.playlist.length === 0) {
      return { success: false, message: 'No tracks in playlist' };
    }

    if (this.currentIndex >= this.playlist.length - 1) {
      if (this.loop) {
        this.currentIndex = 0;
      } else {
        return { success: false, message: 'End of playlist reached' };
      }
    } else {
      this.currentIndex++;
    }

    this.currentTrack = this.playlist[this.currentIndex];
    this.resetProgress();
    return { 
      success: true, 
      track: this.currentTrack,
      message: `Now playing: ${this.currentTrack.name}`,
      isEndOfPlaylist: false
    };
  }

  hasNextTrack() {
    return this.currentIndex < this.playlist.length - 1 || this.loop;
  }

  getCurrentProgress() {
    if (!this.currentTrack || !this.startTime) {
      return { current: '0:00', total: '0:00', percentage: 0, progressBar: '▱▱▱▱▱▱▱▱▱▱' };
    }

    const now = this.isPaused ? this.startTime : Date.now();
    const elapsed = this.isPaused ? this.pausedTime : (now - this.startTime + this.pausedTime);
    const elapsedSeconds = Math.floor(elapsed / 1000);

    const [trackMinutes, trackSeconds] = this.currentTrack.duration.split(':').map(Number);
    const totalSeconds = trackMinutes * 60 + trackSeconds;

    const percentage = Math.min((elapsedSeconds / totalSeconds) * 100, 100);

    const currentMinutes = Math.floor(elapsedSeconds / 60);
    const currentSeconds = elapsedSeconds % 60;
    const currentTime = `${currentMinutes}:${currentSeconds.toString().padStart(2, '0')}`;

    const progressBarLength = 20;
    const filledBars = Math.floor((percentage / 100) * progressBarLength);
    const emptyBars = progressBarLength - filledBars;
    const progressBar = '█'.repeat(filledBars) + '▱'.repeat(emptyBars);

    return {
      current: currentTime,
      total: this.currentTrack.duration,
      percentage: Math.floor(percentage),
      progressBar: progressBar
    };
  }

  getCurrentPlaylistType() {
    for (let [name, playlist] of this.customPlaylists) {
      if (this.playlist === playlist) {
        return name;
      }
    }
    return null;
  }

  saveCustomPlaylists() {
    try {
      const playlistData = Array.from(this.customPlaylists).map(([name, playlist]) => ({
        name,
        tracks: playlist.map(track => track.path)
      }));
      const filePath = path.join(__dirname, 'custom_playlists.json');
      fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));
    } catch (error) {
      console.error('Error saving custom playlists:', error);
    }
  }

  loadCustomPlaylists() {
    try {
      const filePath = path.join(__dirname, 'custom_playlists.json');
      if (fs.existsSync(filePath)) {
        const playlistData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        playlistData.forEach(({ name, tracks }) => {
          const playlist = [];
          tracks.forEach(trackPath => {
            const track = this.findTrackByPath(trackPath);
            if (track) {
              playlist.push(track);
            }
          });
          this.customPlaylists.set(name, playlist);
        });
      }
    } catch (error) {
      console.error('Error loading custom playlists:', error);
    }
  }

  findTrackByPath(trackPath) {
    const musicFiles = this.scanForMusic();
    return musicFiles.find(track => track.path === trackPath);
  }

  createCustomPlaylist(playlistName, tracks = []) {
    if (this.customPlaylists.has(playlistName)) {
      return { success: false, message: `Playlist "${playlistName}" already exists.` };
    }

    this.customPlaylists.set(playlistName, tracks);
    this.saveCustomPlaylists();
    return { success: true, message: `Playlist "${playlistName}" created successfully.` };
  }

  addTrackToPlaylist(playlistName, track) {
    if (!this.customPlaylists.has(playlistName)) {
      return { success: false, message: `Playlist "${playlistName}" does not exist.` };
    }

    const playlist = this.customPlaylists.get(playlistName);
    playlist.push(track);
    this.saveCustomPlaylists();
    return { success: true, message: `Track "${track.name}" added to playlist "${playlistName}".` };
  }

  loadCustomPlaylistByName(playlistName) {
    if (this.customPlaylists.has(playlistName)) {
      this.playlist = this.customPlaylists.get(playlistName);
      this.originalPlaylist = [...this.playlist];
      return this.playlist;
    }
    return [];
  }

  getCustomPlaylistsList() {
    return Array.from(this.customPlaylists.entries()).map(([name, playlist]) => ({
      name,
      trackCount: playlist.length,
      createdAt: Date.now()
    }));
  }

  addToCustomPlaylist(playlistName, searchTerm = null, trackIndex = null) {
    let tracksToAdd = [];

    if (trackIndex !== null && this.playlist[trackIndex]) {
      tracksToAdd = [this.playlist[trackIndex]];
    } else if (searchTerm) {
      tracksToAdd = this.playlist.filter(track => 
        track.name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    } else if (this.currentTrack) {
      tracksToAdd = [this.currentTrack];
    }

    if (tracksToAdd.length === 0) {
      return { success: false, message: 'No tracks found to add' };
    }

    if (!this.customPlaylists.has(playlistName)) {
      this.customPlaylists.set(playlistName, []);
    }

    const playlist = this.customPlaylists.get(playlistName);
    let addedCount = 0;

    tracksToAdd.forEach(track => {
      if (!playlist.some(existing => existing.path === track.path)) {
        playlist.push(track);
        addedCount++;
      }
    });

    this.saveCustomPlaylists();

    return {
      success: true,
      message: `Added ${addedCount} track(s) to playlist "${playlistName}"`,
      tracksAdded: addedCount,
      totalInPlaylist: playlist.length,
      addedTracks: tracksToAdd
    };
  }

  addCurrentToPlaylist(playlistName) {
    if (!this.currentTrack) {
      return { success: false, message: 'No track currently playing' };
    }

    return this.addToCustomPlaylist(playlistName);
  }

  getCustomPlaylistsEmbed() {
    const customPlaylists = this.getCustomPlaylistsList();

    if (customPlaylists.length === 0) {
      return new EmbedBuilder()
        .setColor(0x636363)
        .setTitle('📝 Custom Playlists')
        .setDescription('No custom playlists found. Create some with `/localaddtoplaylist`!')
        .setTimestamp();
    }

    const playlistList = customPlaylists.map((playlist, index) => 
      `${index + 1}. **${playlist.name}** (${playlist.trackCount} tracks)`
    ).join('\n');

    return new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('📝 Your Custom Playlists')
      .setDescription(playlistList)
      .addFields(
        { name: 'Total Playlists', value: customPlaylists.length.toString(), inline: true },
        { name: 'Total Custom Tracks', value: customPlaylists.reduce((sum, pl) => sum + pl.trackCount, 0).toString(), inline: true }
      )
      .setTimestamp();
  }

  getCustomLocalNowPlayingWidget() {
    // Force refresh icons to ensure latest are loaded
    if (this.iconManager) {
      this.iconManager.loadCustomIcons();
    }

    if (!this.currentTrack) {
      // Compact modern idle display with custom icons
      const idleIconUrl = this.iconManager ? this.iconManager.getCustomIconUrl('play') : null;
      const thumbnailUrl = idleIconUrl || 'https://cdn.discordapp.com/emojis/852881704776146954.gif';

      const compactEmbed = new EmbedBuilder()
        .setColor(0x2F3136)
        .setDescription(`🎵 **Music Player** • Ready\n\`\`\`\n⏹️ Idle • ${this.playlist.length} tracks • Vol ${this.volume}%\n🔁 ${this.loop ? 'ON' : 'OFF'} • 🔀 ${this.shuffle ? 'ON' : 'OFF'} • 📝 ${this.customPlaylists.size} playlists\n\`\`\``)
        .setThumbnail(thumbnailUrl)
        .addFields({
          name: '🎨 Custom Icons',
          value: this.iconManager ? `${this.iconManager.customIcons.size} active` : 'Not available',
          inline: true
        });

      return {
        embeds: [compactEmbed],
        components: this.getCompactIdlePlayerButtons()
      };
    }

    const actuallyPlaying = this.isActuallyPlaying();
    const actuallyPaused = this.isActuallyPaused();
    const progress = this.getCurrentProgress();

    // Compact status
    const statusIcon = actuallyPaused ? '⏸️' : actuallyPlaying ? '▶️' : this.isPlaying ? '🔄' : '⏹️';
    const statusText = actuallyPaused ? 'Paused' : actuallyPlaying ? 'Playing' : this.isPlaying ? 'Loading' : 'Stopped';

    // Dynamic color based on status
    let embedColor = 0x5865F2; // Discord blurple
    if (actuallyPlaying || this.isPlaying) {
      embedColor = 0x57F287; // Green for playing
    } else if (actuallyPaused) {
      embedColor = 0xFEE75C; // Yellow for paused
    }

    // Get custom icon URLs for thumbnail with enhanced detection
    let thumbnailUrl = 'https://cdn.discordapp.com/emojis/852881704776146954.gif';
    
    if (this.iconManager) {
      if (actuallyPlaying || this.isPlaying) {
        const playIconUrl = this.iconManager.getAnimatedIconUrl('play') || this.iconManager.getCustomIconUrl('play');
        if (playIconUrl) thumbnailUrl = playIconUrl;
      } else if (actuallyPaused) {
        const pauseIconUrl = this.iconManager.getAnimatedIconUrl('pause') || this.iconManager.getCustomIconUrl('pause');
        if (pauseIconUrl) thumbnailUrl = pauseIconUrl;
      }
    }

    // Compact progress bar (shorter)
    const progressBar = progress.progressBar.substring(0, 12);

    // Get custom icon count for display
    const customIconCount = this.iconManager ? this.iconManager.customIcons.size : 0;
    const animatedIconCount = this.iconManager ? 
      Array.from(this.iconManager.customIcons.values()).filter(icon => icon.isAnimated).length : 0;

    const compactEmbed = new EmbedBuilder()
      .setColor(embedColor)
      .setDescription(`🎵 **${this.currentTrack.name.substring(0, 35)}**\n\`\`\`\n${statusIcon} ${statusText} • ${progress.current}/${progress.total} • ${progress.percentage}%\n${progressBar}\nTrack ${this.currentIndex + 1}/${this.playlist.length} • Vol ${this.volume}% • ${this.loop ? '🔁' : '▶️'} ${this.shuffle ? '🔀' : '📋'}\n\`\`\``)
      .setThumbnail(thumbnailUrl)
      .setFooter({ 
        text: `${this.currentTrack.extension.toUpperCase()} • ${(this.currentTrack.size / 1024 / 1024).toFixed(1)}MB • ${customIconCount} custom icons (${animatedIconCount} animated)` 
      });

    return {
      embeds: [compactEmbed],
      components: this.getCompactPlayerButtons()
    };
  }

  getCustomPlaylistWidget() {
    return this.getCustomLocalNowPlayingWidget();
  }

  getIconManager() {
    return this.iconManager;
  }
}

module.exports = LocalMusicPlayer;
