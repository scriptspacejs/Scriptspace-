
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

class IconManager {
  constructor() {
    this.iconFolder = './assets/player-icons';
    this.allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    this.defaultIcons = {
      play: '▶️',
      pause: '⏸️',
      previous: '⏮️',
      next: '⏭️',
      volumeDown: '🔉',
      volumeUp: '🔊',
      loop: '🔁',
      shuffle: '🔀',
      stop: '⏹️',
      refresh: '🔄'
    };
    this.customIcons = new Map();
    this.initializeIconFolder();
    this.loadCustomIcons();
    this.setupFileWatcher();
  }

  initializeIconFolder() {
    if (!fs.existsSync(this.iconFolder)) {
      fs.mkdirSync(this.iconFolder, { recursive: true });
      console.log(`📁 Created icon folder: ${this.iconFolder}`);
    }

    // Create subdirectories for organization
    const subFolders = ['buttons', 'backgrounds', 'animations'];
    subFolders.forEach(folder => {
      const folderPath = path.join(this.iconFolder, folder);
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
    });
  }

  loadCustomIcons() {
    try {
      const configPath = path.join(this.iconFolder, 'icon-config.json');
      if (fs.existsSync(configPath)) {
        // Clear existing icons first
        this.customIcons.clear();
        
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        
        // Validate that files still exist before loading
        for (const [iconType, iconData] of Object.entries(config)) {
          if (iconData.path && fs.existsSync(iconData.path)) {
            this.customIcons.set(iconType, iconData);
          } else {
            console.warn(`⚠️ Custom icon file missing: ${iconData.path}`);
          }
        }
        
        console.log(`📋 Loaded ${this.customIcons.size} custom icon mappings`);
        
        // Save cleaned config
        this.saveCustomIcons();
      }
    } catch (error) {
      console.error('Error loading custom icons:', error);
      this.customIcons.clear();
    }
  }

  saveCustomIcons() {
    try {
      const configPath = path.join(this.iconFolder, 'icon-config.json');
      const config = Object.fromEntries(this.customIcons);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error saving custom icons:', error);
    }
  }

  scanForIcons() {
    const icons = [];
    
    const scanFolder = (folderPath, category = 'general') => {
      if (!fs.existsSync(folderPath)) return;
      
      const files = fs.readdirSync(folderPath);
      files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (this.allowedExtensions.includes(ext)) {
          const fullPath = path.join(folderPath, file);
          const stats = fs.statSync(fullPath);
          icons.push({
            name: path.basename(file, ext),
            filename: file,
            path: fullPath,
            category,
            size: stats.size,
            extension: ext,
            url: this.getIconUrl(fullPath)
          });
        }
      });
    };

    // Scan main folder
    scanFolder(this.iconFolder, 'general');
    
    // Scan subfolders
    scanFolder(path.join(this.iconFolder, 'buttons'), 'buttons');
    scanFolder(path.join(this.iconFolder, 'backgrounds'), 'backgrounds');
    scanFolder(path.join(this.iconFolder, 'animations'), 'animations');

    return icons;
  }

  getIconUrl(filePath) {
    // Convert local file path to accessible URL
    // This would need to be adapted based on your hosting setup
    const relativePath = path.relative('.', filePath);
    return `/${relativePath.replace(/\\/g, '/')}`;
  }

  async handleFileUpload(attachment, iconType, category = 'buttons') {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    
    if (!attachment.contentType || !allowedTypes.includes(attachment.contentType)) {
      return { 
        success: false, 
        message: 'Invalid file type. Supported: PNG, JPG, JPEG, GIF, WEBP' 
      };
    }

    if (attachment.size > 8 * 1024 * 1024) { // 8MB limit for animations
      return { 
        success: false, 
        message: 'File too large. Maximum size: 8MB' 
      };
    }

    try {
      const ext = path.extname(attachment.name).toLowerCase();
      const fileName = `${iconType}_${Date.now()}${ext}`;
      const categoryFolder = path.join(this.iconFolder, category);
      const filePath = path.join(categoryFolder, fileName);

      // Download and save the file
      const fetch = require('node-fetch');
      const response = await fetch(attachment.url);
      const buffer = await response.buffer();
      
      fs.writeFileSync(filePath, buffer);

      // Determine if file is animated
      const isAnimated = ext === '.gif' || attachment.name.toLowerCase().includes('anim');
      
      // Update custom icons mapping with animation support
      this.customIcons.set(iconType, {
        path: filePath,
        url: attachment.url, // Use Discord's URL for better compatibility
        localUrl: this.getIconUrl(filePath),
        category,
        isAnimated,
        fileSize: attachment.size,
        uploadedAt: Date.now()
      });

      this.saveCustomIcons();

      return {
        success: true,
        message: `Custom ${isAnimated ? 'animated ' : ''}icon for ${iconType} uploaded successfully`,
        filePath,
        fileName,
        isAnimated
      };
    } catch (error) {
      console.error('File upload error:', error);
      return {
        success: false,
        message: 'Failed to upload icon file'
      };
    }
  }

  getIcon(iconType) {
    // For Discord buttons, we need to use Unicode emojis only
    // Custom image icons can't be used directly in Discord buttons
    // Return the default emoji as fallback
    return this.defaultIcons[iconType];
  }

  getCustomIconUrl(iconType) {
    // Method to get custom icon URL for embeds/messages (not buttons)
    if (this.customIcons.has(iconType)) {
      const customIcon = this.customIcons.get(iconType);
      return customIcon.url || customIcon.localUrl;
    }
    return null;
  }

  getAnimatedIconUrl(iconType) {
    // Specifically for animated icons
    if (this.customIcons.has(iconType)) {
      const customIcon = this.customIcons.get(iconType);
      if (customIcon.isAnimated) {
        return customIcon.url || customIcon.localUrl;
      }
    }
    return null;
  }

  isAnimatedIcon(iconType) {
    if (this.customIcons.has(iconType)) {
      const customIcon = this.customIcons.get(iconType);
      return customIcon.isAnimated || false;
    }
    return false;
  }

  hasCustomIcon(iconType) {
    return this.customIcons.has(iconType);
  }

  removeCustomIcon(iconType) {
    if (this.customIcons.has(iconType)) {
      const customIcon = this.customIcons.get(iconType);
      try {
        if (fs.existsSync(customIcon.path)) {
          fs.unlinkSync(customIcon.path);
        }
        this.customIcons.delete(iconType);
        this.saveCustomIcons();
        return { success: true, message: `Removed custom icon for ${iconType}` };
      } catch (error) {
        console.error('Error removing icon:', error);
        return { success: false, message: 'Failed to remove icon file' };
      }
    }
    return { success: false, message: 'No custom icon found for this type' };
  }

  getIconManagerEmbed() {
    const availableIcons = this.scanForIcons();
    const iconTypes = Object.keys(this.defaultIcons);

    const iconList = iconTypes.map(type => {
      const hasCustom = this.customIcons.has(type);
      if (hasCustom) {
        const customIcon = this.customIcons.get(type);
        const isAnimated = customIcon.isAnimated;
        const icon = isAnimated ? '🎬' : '🎨';
        const status = isAnimated ? 'Animated' : 'Custom';
        return `${icon} **${type}** - ${status}`;
      } else {
        return `🔄 **${type}** - Default`;
      }
    }).join('\n');

    const categoryStats = availableIcons.reduce((acc, icon) => {
      acc[icon.category] = (acc[icon.category] || 0) + 1;
      return acc;
    }, {});

    const animatedCount = Array.from(this.customIcons.values()).filter(icon => icon.isAnimated).length;
    const customCount = this.customIcons.size;

    const statsText = Object.entries(categoryStats)
      .map(([category, count]) => `${category}: ${count}`)
      .join('\n') || 'No custom icons';

    return new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('🎨 Custom Player Icon Manager')
      .setDescription('**Current Icon Status:**\n' + iconList)
      .addFields(
        { name: '📊 Icon Statistics', value: statsText, inline: true },
        { name: '🎬 Animation Status', value: `${animatedCount} animated\n${customCount - animatedCount} static`, inline: true },
        { name: '🔧 Supported Formats', value: 'PNG, JPG, JPEG, GIF, WEBP', inline: true },
        { 
          name: '📝 How to Upload Icons', 
          value: 'Use `/iconupload type:ICON_TYPE` with an attachment\nGIFs will be automatically detected as animated', 
          inline: false 
        },
        { 
          name: '🎮 Available Icon Types', 
          value: iconTypes.join(', '), 
          inline: false 
        },
        {
          name: '🎬 Animation Support',
          value: 'Animated GIFs work in embeds and widgets!\nNote: Discord buttons only support emoji',
          inline: false
        },
        {
          name: '⚡ Auto-Update Feature',
          value: '🔄 File watcher monitors icon folders\n📁 Automatically detects new uploads\n🎨 Real-time icon updates without restart\n🗑️ Auto-removes deleted icons',
          inline: false
        }
      )
      .setFooter({ text: 'Custom Icon Manager • Animation Support Enabled' })
      .setTimestamp();
  }

  getIconManagerButtons() {
    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('icon_refresh_scan')
          .setLabel('Refresh Icons')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('icon_show_gallery')
          .setLabel('View Gallery')
          .setEmoji('🖼️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('icon_reset_all')
          .setLabel('Reset All')
          .setEmoji('♻️')
          .setStyle(ButtonStyle.Danger)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('icon_help')
          .setLabel('Upload Help')
          .setEmoji('❓')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('icon_export_config')
          .setLabel('Export Config')
          .setEmoji('💾')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('icon_import_config')
          .setLabel('Import Config')
          .setEmoji('📥')
          .setStyle(ButtonStyle.Secondary)
      );

    return [row1, row2];
  }

  getIconGallery(page = 1, itemsPerPage = 6) {
    const icons = this.scanForIcons();
    const totalPages = Math.ceil(icons.length / itemsPerPage);
    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, icons.length);

    const pageIcons = icons.slice(startIndex, endIndex);

    const iconList = pageIcons.map((icon, index) => {
      const globalIndex = startIndex + index + 1;
      const sizeKB = (icon.size / 1024).toFixed(2);
      return `${globalIndex}. **${icon.name}**\n   📁 ${icon.category} • ${icon.extension.toUpperCase()} • ${sizeKB}KB`;
    }).join('\n\n') || 'No custom icons found';

    return new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('🖼️ Custom Icon Gallery')
      .setDescription(iconList)
      .addFields(
        { name: '📊 Total Icons', value: icons.length.toString(), inline: true },
        { name: '📄 Current Page', value: `${page}/${totalPages}`, inline: true },
        { name: '💾 Total Size', value: `${(icons.reduce((sum, icon) => sum + icon.size, 0) / 1024 / 1024).toFixed(2)} MB`, inline: true }
      )
      .setFooter({ text: `Icon Gallery • Page ${page}/${totalPages}` })
      .setTimestamp();
  }

  resetAllIcons() {
    try {
      let removedCount = 0;
      for (const [iconType, customIcon] of this.customIcons) {
        if (fs.existsSync(customIcon.path)) {
          fs.unlinkSync(customIcon.path);
          removedCount++;
        }
      }
      this.customIcons.clear();
      this.saveCustomIcons();
      
      return {
        success: true,
        message: `Reset complete! Removed ${removedCount} custom icons.`
      };
    } catch (error) {
      console.error('Error resetting icons:', error);
      return {
        success: false,
        message: 'Failed to reset icons'
      };
    }
  }

  setupFileWatcher() {
    try {
      // Watch the main icon folder and subfolders for changes
      const foldersToWatch = [
        this.iconFolder,
        path.join(this.iconFolder, 'buttons'),
        path.join(this.iconFolder, 'backgrounds'),
        path.join(this.iconFolder, 'animations')
      ];

      foldersToWatch.forEach(folder => {
        if (fs.existsSync(folder)) {
          fs.watch(folder, { recursive: false }, (eventType, filename) => {
            if (filename && this.allowedExtensions.some(ext => filename.toLowerCase().endsWith(ext))) {
              console.log(`📁 Icon file change detected: ${filename} (${eventType})`);
              
              // Debounce rapid changes
              clearTimeout(this.watcherTimeout);
              this.watcherTimeout = setTimeout(() => {
                this.autoUpdateIcons(filename, eventType, folder);
              }, 1000);
            }
          });
          console.log(`👁️ File watcher enabled for: ${folder}`);
        }
      });
    } catch (error) {
      console.error('Error setting up file watcher:', error);
    }
  }

  autoUpdateIcons(filename, eventType, folder) {
    try {
      console.log(`🔄 Auto-updating icons due to ${eventType} on ${filename}`);
      
      const filePath = path.join(folder, filename);
      const iconType = this.detectIconType(filename);
      
      if (eventType === 'rename') {
        if (fs.existsSync(filePath)) {
          // File was added/moved
          this.autoDetectAndAddIcon(filePath, iconType);
        } else {
          // File was deleted/moved away
          this.autoRemoveIcon(filename);
        }
      } else if (eventType === 'change') {
        // File was modified
        if (iconType && fs.existsSync(filePath)) {
          this.autoDetectAndAddIcon(filePath, iconType);
        }
      }
      
      // Force reload all icons
      this.loadCustomIcons();
      console.log(`✅ Auto-update complete: ${this.customIcons.size} icons loaded`);
      
    } catch (error) {
      console.error('Error during auto-update:', error);
    }
  }

  detectIconType(filename) {
    const name = filename.toLowerCase();
    const iconTypes = Object.keys(this.defaultIcons);
    
    // Try to detect icon type from filename
    for (const type of iconTypes) {
      if (name.includes(type)) {
        return type;
      }
    }
    
    // Additional detection patterns
    if (name.includes('vol') && name.includes('down')) return 'volumeDown';
    if (name.includes('vol') && name.includes('up')) return 'volumeUp';
    if (name.includes('prev')) return 'previous';
    if (name.includes('skip')) return 'next';
    
    return null;
  }

  autoDetectAndAddIcon(filePath, iconType) {
    if (!iconType) return;
    
    try {
      const stats = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const category = path.basename(path.dirname(filePath));
      const isAnimated = ext === '.gif';
      
      // Create a mock attachment object for consistency
      const mockAttachment = {
        url: this.getIconUrl(filePath),
        name: path.basename(filePath),
        size: stats.size,
        contentType: this.getContentType(ext)
      };
      
      this.customIcons.set(iconType, {
        path: filePath,
        url: this.getIconUrl(filePath),
        localUrl: this.getIconUrl(filePath),
        category: category,
        isAnimated: isAnimated,
        fileSize: stats.size,
        uploadedAt: Date.now(),
        autoDetected: true
      });
      
      this.saveCustomIcons();
      console.log(`🎨 Auto-detected and added ${iconType} icon: ${path.basename(filePath)}`);
      
    } catch (error) {
      console.error(`Error auto-adding icon ${filePath}:`, error);
    }
  }

  autoRemoveIcon(filename) {
    // Find and remove icon by filename
    for (const [iconType, iconData] of this.customIcons) {
      if (iconData.path && path.basename(iconData.path) === filename) {
        this.customIcons.delete(iconType);
        this.saveCustomIcons();
        console.log(`🗑️ Auto-removed ${iconType} icon: ${filename}`);
        break;
      }
    }
  }

  getContentType(ext) {
    const types = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    return types[ext] || 'image/png';
  }

  clearIconCache() {
    try {
      console.log('🧹 Clearing icon cache...');
      this.customIcons.clear();
      
      // Clear any timeout watchers
      if (this.watcherTimeout) {
        clearTimeout(this.watcherTimeout);
      }
      
      console.log('✅ Icon cache cleared successfully');
      return { success: true, message: 'Icon cache cleared' };
    } catch (error) {
      console.error('Error clearing icon cache:', error);
      return { success: false, message: 'Failed to clear icon cache' };
    }
  }

  forceRefresh() {
    try {
      // Reload from filesystem
      this.loadCustomIcons();
      
      // Rescan icon folders
      const availableIcons = this.scanForIcons();
      
      console.log(`🔄 Force refresh complete: ${this.customIcons.size} custom icons, ${availableIcons.length} total files`);
      
      return {
        success: true,
        customIconCount: this.customIcons.size,
        totalFileCount: availableIcons.length
      };
    } catch (error) {
      console.error('Error during force refresh:', error);
      return {
        success: false,
        message: 'Failed to force refresh icons'
      };
    }
  }

  scanAndAutoDetectIcons() {
    try {
      console.log('🔍 Scanning for new icons and auto-detecting...');
      
      const availableIcons = this.scanForIcons();
      const initialIconCount = this.customIcons.size;
      let newIconsFound = 0;
      let removedIcons = 0;

      // Auto-detect new icons based on filename patterns
      for (const icon of availableIcons) {
        const iconType = this.detectIconType(icon.filename);
        if (iconType) {
          // Check if this is a new icon or update to existing
          const existing = this.customIcons.get(iconType);
          if (!existing || existing.path !== icon.path) {
            this.autoDetectAndAddIcon(icon.path, iconType);
            newIconsFound++;
            console.log(`🆕 Auto-detected new ${iconType} icon: ${icon.filename}`);
          }
        }
      }

      // Remove icons for files that no longer exist
      const iconsToRemove = [];
      for (const [iconType, iconData] of this.customIcons) {
        if (!fs.existsSync(iconData.path)) {
          iconsToRemove.push(iconType);
          removedIcons++;
        }
      }

      iconsToRemove.forEach(iconType => {
        this.customIcons.delete(iconType);
        console.log(`🗑️ Removed missing icon: ${iconType}`);
      });

      // Save updated configuration
      this.saveCustomIcons();

      console.log(`✅ Auto-detection complete: ${newIconsFound} new icons, ${removedIcons} removed`);

      return {
        success: true,
        customIconCount: this.customIcons.size,
        totalFileCount: availableIcons.length,
        newIconsFound: newIconsFound,
        removedIcons: removedIcons
      };
    } catch (error) {
      console.error('Error during auto-detection scan:', error);
      return {
        success: false,
        message: 'Failed to scan and auto-detect icons'
      };
    }
  }

  getIconPreviewEmbed() {
    const iconTypes = Object.keys(this.defaultIcons);
    
    const iconPreview = iconTypes.map(type => {
      const hasCustom = this.customIcons.has(type);
      if (hasCustom) {
        const customIcon = this.customIcons.get(type);
        const isAnimated = customIcon.isAnimated;
        const emoji = isAnimated ? '🎬' : '🎨';
        const status = isAnimated ? 'Animated' : 'Custom';
        const fileName = path.basename(customIcon.path);
        return `${emoji} **${type}** - ${status}\n   📁 \`${fileName}\``;
      } else {
        return `🔄 **${type}** - Default ${this.defaultIcons[type]}`;
      }
    }).join('\n\n');

    const customCount = this.customIcons.size;
    const animatedCount = Array.from(this.customIcons.values()).filter(icon => icon.isAnimated).length;

    return new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('👁️ Custom Icon Preview')
      .setDescription('**Current Icon Status in Music Player:**\n\n' + iconPreview)
      .addFields(
        { name: '🎨 Custom Icons', value: customCount.toString(), inline: true },
        { name: '🎬 Animated Icons', value: animatedCount.toString(), inline: true },
        { name: '📱 Widget Ready', value: '✅ Active', inline: true }
      )
      .addFields({
        name: '💡 Integration Status',
        value: `✅ Icons are automatically applied to music player widget\n🔄 Custom icons show in embeds and thumbnails\n📱 Discord buttons use emoji fallbacks\n⚡ Real-time updates enabled`,
        inline: false
      })
      .setFooter({ text: 'Icon Preview • Icons active in music player widget' })
      .setTimestamp();
  }
}

module.exports = IconManager;
