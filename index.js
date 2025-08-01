const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const fs = require('fs');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus,  getVoiceConnection } = require("@discordjs/voice");
const Tesseract = require("tesseract.js");
// Dynamic import for node-fetch will be handled in the functions that use it
const { startServer } = require("./alive.js");
const LocalMusicPlayer = require("./music-player.js");
const UptimeMonitor = require("./uptime-monitor.js");
const KeepAliveService = require("./keep-alive-service.js");
require("dotenv").config();

// Validate required environment variables
if (!process.env.TOKEN) {
  console.error('❌ CRITICAL ERROR: No Discord bot token provided!');
  console.error('📝 Please add your bot token to Replit Secrets:');
  console.error('   1. Click the Secrets tab (🔒) in the left sidebar');
  console.error('   2. Add a new secret with key: TOKEN');
  console.error('   3. Paste your Discord bot token as the value');
  console.error('   4. Get your token from: https://discord.com/developers/applications');
  process.exit(1);
}



// Configuration
const TENOR_API_KEY = process.env.TENOR_API_KEY || "AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ";
const TENOR_BASE_URL = "https://tenor.googleapis.com/v2/search";
const BOT_PREFIX = "S!";
let allowed_channel_ids = [];
let image2textChannels = [];

try {
  const config = require("./config.json");
  allowed_channel_ids = config.allowed_channel_ids || [];
  image2textChannels = config.image2textChannels || [];
} catch (error) {
  console.log("⚠️ Config file not found, using default settings");
}



// Rate limiting
const userCooldowns = new Map();
const COOLDOWN_TIME = 1000;
const developerCommandCooldowns = new Map();
const DEVELOPER_COOLDOWN_TIME = 24 * 60 * 60 * 1000;

// Music player storage
const musicQueues = new Map();
const voiceConnections = new Map();
const localMusicPlayers = new Map();
let uptimeMonitor = null;
let keepAliveService = null;

// Sticky Notes System
const stickyNotes = new Map();
const globalStickyNotes = new Map(); // Store global sticky notes by title
const STICKY_NOTES_FILE = './sticky-notes.json';
const GLOBAL_STICKY_NOTES_FILE = './global-sticky-notes.json';

// Load sticky notes from file
function loadStickyNotes() {
  try {
    if (fs.existsSync(STICKY_NOTES_FILE)) {
      const data = fs.readFileSync(STICKY_NOTES_FILE, 'utf8');
      const notes = JSON.parse(data);
      for (const [key, value] of Object.entries(notes)) {
        stickyNotes.set(key, value);
      }
      console.log(`📌 Loaded ${stickyNotes.size} sticky notes`);
    }
  } catch (error) {
    console.error('Error loading sticky notes:', error);
  }
}

// Save sticky notes to file
function saveStickyNotes() {
  try {
    const notesObject = Object.fromEntries(stickyNotes);
    fs.writeFileSync(STICKY_NOTES_FILE, JSON.stringify(notesObject, null, 2));
  } catch (error) {
    console.error('Error saving sticky notes:', error);
  }
}

// Load global sticky notes from file
function loadGlobalStickyNotes() {
  try {
    if (fs.existsSync(GLOBAL_STICKY_NOTES_FILE)) {
      const data = fs.readFileSync(GLOBAL_STICKY_NOTES_FILE, 'utf8');
      const notes = JSON.parse(data);
      for (const [key, value] of Object.entries(notes)) {
        globalStickyNotes.set(key, value);
      }
      console.log(`🌐 Loaded ${globalStickyNotes.size} global sticky notes`);
    }
  } catch (error) {
    console.error('Error loading global sticky notes:', error);
  }
}

// Save global sticky notes to file
function saveGlobalStickyNotes() {
  try {
    const notesObject = Object.fromEntries(globalStickyNotes);
    fs.writeFileSync(GLOBAL_STICKY_NOTES_FILE, JSON.stringify(notesObject, null, 2));
  } catch (error) {
    console.error('Error saving global sticky notes:', error);
  }
}

// Enhanced sticky note creation with image/GIF link support
async function createStickyNote(channel, options) {
  try {
    const { title, text, author, imageUrl, thumbnailUrl, color, persistent = true, linkUrl } = options;
    
    // Validate and process image/GIF links
    let processedImageUrl = imageUrl;
    let processedText = text;
    
    if (linkUrl) {
      // Validate if it's an image/GIF link
      if (isValidImageUrl(linkUrl)) {
        processedImageUrl = linkUrl;
        processedText += `\n\n🔗 **Image Link:** ${linkUrl}`;
      } else {
        processedText += `\n\n🔗 **Link:** ${linkUrl}`;
      }
    }
    
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(processedText)
      .setColor(color ? parseInt(color, 16) : 0x1DB954)
      .setTimestamp();

    if (author) {
      embed.setAuthor({ name: author });
    }

    if (processedImageUrl) {
      embed.setImage(processedImageUrl);
    }

    if (thumbnailUrl) {
      embed.setThumbnail(thumbnailUrl);
    }

    embed.setFooter({ text: `📌 Enhanced Sticky Note • ${persistent ? 'Auto-Persistent' : 'Static'} • Bottom Locked` });

    // Send at bottom of channel with enhanced positioning
    const message = await channel.send({ embeds: [embed] });
    await message.pin();

    // Store enhanced sticky note data
    const noteData = {
      channelId: channel.id,
      guildId: channel.guild.id,
      messageId: message.id,
      title,
      text: processedText,
      author,
      imageUrl: processedImageUrl,
      thumbnailUrl,
      linkUrl,
      color,
      persistent,
      createdAt: Date.now(),
      lastReposted: Date.now(),
      repositionAttempts: 0,
      enhanced: true
    };

    stickyNotes.set(channel.id, noteData);
    saveStickyNotes();

    // Schedule periodic repositioning to bottom
    if (persistent) {
      scheduleBottomRepositioning(channel.id);
    }

    return { success: true, message: message };
  } catch (error) {
    console.error('Error creating enhanced sticky note:', error);
    return { success: false, error: error.message };
  }
}

// Validate image/GIF URLs
function isValidImageUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
    const gifHosts = ['tenor.com', 'giphy.com', 'imgur.com', 'discord.com', 'cdn.discordapp.com'];
    
    // Check file extension
    if (imageExtensions.some(ext => pathname.endsWith(ext))) {
      return true;
    }
    
    // Check known GIF hosting services
    if (gifHosts.some(host => urlObj.hostname.includes(host))) {
      return true;
    }
    
    // Check for common image/gif parameters
    if (urlObj.search.includes('format=gif') || urlObj.search.includes('type=image')) {
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// Schedule bottom repositioning for persistent sticky notes
function scheduleBottomRepositioning(channelId) {
  // Reposition every 5 minutes to ensure it stays at bottom
  setInterval(async () => {
    try {
      const noteData = stickyNotes.get(channelId);
      if (!noteData || !noteData.persistent) return;
      
      const channel = client.channels.cache.get(channelId);
      if (!channel) return;
      
      // Check if sticky note is still at bottom (within last 10 messages)
      const recentMessages = await channel.messages.fetch({ limit: 10 });
      const stickyMessage = recentMessages.get(noteData.messageId);
      
      if (!stickyMessage) {
        // Sticky note was deleted, repost it
        await repostStickyNote(channel);
      } else {
        // Check if it's not in the last 3 messages, then reposition
        const messageArray = Array.from(recentMessages.values());
        const stickyIndex = messageArray.findIndex(msg => msg.id === noteData.messageId);
        
        if (stickyIndex > 2) {
          // Delete and repost to move to bottom
          try {
            await stickyMessage.delete();
            await repostStickyNote(channel);
          } catch (error) {
            console.error('Error repositioning sticky note:', error);
          }
        }
      }
    } catch (error) {
      console.error('Error in bottom repositioning:', error);
    }
  }, 5 * 60 * 1000); // Every 5 minutes
}

// Remove sticky note
async function removeStickyNote(channel) {
  try {
    const noteData = stickyNotes.get(channel.id);
    if (!noteData) {
      return { success: false, error: 'No sticky note found in this channel' };
    }

    try {
      const message = await channel.messages.fetch(noteData.messageId);
      await message.delete();
    } catch (error) {
      // Message might already be deleted
    }

    stickyNotes.delete(channel.id);
    saveStickyNotes();

    return { success: true };
  } catch (error) {
    console.error('Error removing sticky note:', error);
    return { success: false, error: error.message };
  }
}

// Enhanced repost functionality with image/GIF support and bottom positioning
async function repostStickyNote(channel) {
  try {
    const noteData = stickyNotes.get(channel.id);
    if (!noteData || !noteData.persistent) {
      return;
    }

    // Reduced cooldown for more aggressive persistence (30 seconds)
    const now = Date.now();
    if (now - noteData.lastReposted < 30000) {
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(noteData.title)
      .setDescription(noteData.text)
      .setColor(noteData.color ? parseInt(noteData.color, 16) : 0x1DB954)
      .setTimestamp();

    if (noteData.author) {
      embed.setAuthor({ name: noteData.author });
    }

    // Enhanced image/GIF support
    if (noteData.imageUrl) {
      embed.setImage(noteData.imageUrl);
    }

    if (noteData.thumbnailUrl) {
      embed.setThumbnail(noteData.thumbnailUrl);
    }

    // Enhanced footer with repositioning info
    const repositionCount = noteData.repositionAttempts || 0;
    const footerText = noteData.isGlobal ? 
      `📌 Global Enhanced Sticky • Auto-persistent • Repositioned ${repositionCount}x` : 
      `📌 Enhanced Sticky • Auto-persistent • Bottom Locked • Repositioned ${repositionCount}x`;
    embed.setFooter({ text: footerText });

    // Send new message at bottom
    const message = await channel.send({ embeds: [embed] });
    await message.pin();

    // Update stored data with enhanced tracking
    noteData.messageId = message.id;
    noteData.lastReposted = now;
    noteData.repositionAttempts = repositionCount + 1;
    stickyNotes.set(channel.id, noteData);
    saveStickyNotes();

    console.log(`📌 Enhanced sticky note reposted in ${channel.name} (${repositionCount + 1}x repositioned)`);
  } catch (error) {
    console.error('Error reposting enhanced sticky note:', error);
  }
}

// Deploy sticky note to all channels
async function deployGlobalStickyNote(guild, options) {
  const { title, text, author, imageUrl, thumbnailUrl, color, persistent = true } = options;
  
  // Get all text channels where bot has permissions
  const textChannels = guild.channels.cache.filter(channel => 
    channel.type === 0 && // Text channel
    channel.permissionsFor(guild.members.me).has([
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ManageMessages
    ])
  );

  let successCount = 0;
  let failCount = 0;
  const deployedChannels = [];

  for (const [channelId, channel] of textChannels) {
    try {
      // Skip if channel already has a sticky note
      if (stickyNotes.has(channelId)) {
        failCount++;
        continue;
      }

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(text)
        .setColor(color ? parseInt(color, 16) : 0x1DB954)
        .setTimestamp();

      if (author) {
        embed.setAuthor({ name: author });
      }

      if (imageUrl) {
        embed.setImage(imageUrl);
      }

      if (thumbnailUrl) {
        embed.setThumbnail(thumbnailUrl);
      }

      embed.setFooter({ text: `📌 Global Sticky Note • ${persistent ? 'Persistent' : 'Static'}` });

      const message = await channel.send({ embeds: [embed] });
      await message.pin();

      // Store sticky note data
      const noteData = {
        channelId: channel.id,
        guildId: guild.id,
        messageId: message.id,
        title,
        text,
        author,
        imageUrl,
        thumbnailUrl,
        color,
        persistent,
        isGlobal: true,
        globalTitle: title,
        createdAt: Date.now(),
        lastReposted: Date.now()
      };

      stickyNotes.set(channel.id, noteData);
      deployedChannels.push({ id: channel.id, name: channel.name });
      successCount++;

    } catch (error) {
      console.error(`Failed to deploy to ${channel.name}:`, error);
      failCount++;
    }
  }

  // Save global sticky note reference
  globalStickyNotes.set(title, {
    title,
    text,
    author,
    imageUrl,
    thumbnailUrl,
    color,
    persistent,
    guildId: guild.id,
    deployedChannels,
    createdAt: Date.now()
  });

  saveStickyNotes();
  saveGlobalStickyNotes();

  return {
    success: true,
    successCount,
    failCount,
    totalChannels: textChannels.size,
    deployedChannels
  };
}

// Enhanced Anti-Nuke System - Extremely Strong Protection
const antiNukeConfig = {
  enabled: true,
  // More aggressive limits for maximum protection
  maxChannelDeletes: 2,    // Reduced from 3
  maxRoleDeletes: 2,       // Reduced from 3  
  maxBans: 3,              // Reduced from 5
  maxKicks: 3,             // Reduced from 5
  maxChannelCreates: 3,    // Reduced from 5
  maxRoleCreates: 3,       // Reduced from 5
  maxMemberUpdates: 5,     // New protection
  maxMessageDeletes: 10,   // New protection
  maxWebhookCreates: 2,    // New protection
  maxInviteCreates: 3,     // New protection
  timeWindow: 30000,       // Reduced from 60000 (30 seconds)
  punishmentType: 'ban',
  whitelistedUsers: [],
  whitelistedRoles: [],
  logChannelId: null,
  // Enhanced features
  autoLockdown: true,      // Auto-lock server during attacks
  emergencyMode: false,    // Emergency lockdown state
  suspiciousActivityThreshold: 15, // Trigger emergency mode
  instantBanSuspiciousUsers: true, // Ban highly suspicious users instantly
  protectStickyNotes: true,        // Extra protection for sticky notes
  multiActionDetection: true,      // Detect multiple different suspicious actions
  ipTrackingEnabled: true          // Track suspicious IP patterns
};

// Enhanced Anti-Nuke Data Tracking
const antiNukeData = {
  channelDeletes: new Map(),
  roleDeletes: new Map(),
  bans: new Map(),
  kicks: new Map(),
  channelCreates: new Map(),
  roleCreates: new Map(),
  memberUpdates: new Map(),
  messageDeletes: new Map(),
  webhookCreates: new Map(),
  inviteCreates: new Map(),
  stickyNoteDeletes: new Map(),
  suspiciousActivities: new Map(),
  emergencyTriggers: new Map(),
  multiActionUsers: new Map(),
  lastEmergencyMode: 0
};

// Anti-nuke functions
function isWhitelisted(member) {
  if (!member) return false;
  if (antiNukeConfig.whitelistedUsers.includes(member.id)) return true;
  const hasWhitelistedRole = member.roles.cache.some(role => 
    antiNukeConfig.whitelistedRoles.includes(role.id)
  );
  return hasWhitelistedRole;
}

// Enhanced Anti-Nuke Checking with Extremely Strong Multi-Layer Protection
function checkAntiNuke(guild, userId, action, limit) {
  if (!antiNukeConfig.enabled) return false;
  const member = guild.members.cache.get(userId);
  if (!member || isWhitelisted(member)) return false;

  const now = Date.now();
  const userActions = antiNukeData[action].get(userId) || [];
  const recentActions = userActions.filter(timestamp => 
    now - timestamp < antiNukeConfig.timeWindow
  );

  recentActions.push(now);
  antiNukeData[action].set(userId, recentActions);

  // Multi-action detection - track all actions by user
  const allUserActions = antiNukeData.multiActionUsers.get(userId) || [];
  allUserActions.push({ action, timestamp: now });
  antiNukeData.multiActionUsers.set(userId, allUserActions.filter(a => 
    now - a.timestamp < antiNukeConfig.timeWindow * 2
  ));

  // Calculate total suspicious activity
  const totalSuspiciousActions = allUserActions.length;
  const uniqueActions = new Set(allUserActions.map(a => a.action)).size;

  // Instant ban for extremely suspicious behavior
  if (antiNukeConfig.instantBanSuspiciousUsers && 
      (totalSuspiciousActions >= 8 || uniqueActions >= 4)) {
    console.log(`🚨 INSTANT BAN: ${member.user.tag} - Extremely suspicious activity detected`);
    punishUser(guild, member, 'instant_suspicious', totalSuspiciousActions);
    triggerEmergencyMode(guild, userId, 'instant_suspicious');
    return true;
  }

  // Check individual action limits
  if (recentActions.length > limit) {
    console.log(`🚨 ANTI-NUKE TRIGGERED: ${member.user.tag} exceeded ${action} limit (${recentActions.length}/${limit})`);
    punishUser(guild, member, action, recentActions.length);
    
    // Check if emergency mode should be triggered
    if (totalSuspiciousActions >= antiNukeConfig.suspiciousActivityThreshold) {
      triggerEmergencyMode(guild, userId, action);
    }
    
    return true;
  }

  // Track for suspicious activity monitoring
  const suspiciousActivities = antiNukeData.suspiciousActivities.get(userId) || [];
  suspiciousActivities.push({ action, timestamp: now, count: recentActions.length });
  antiNukeData.suspiciousActivities.set(userId, suspiciousActivities.filter(a => 
    now - a.timestamp < antiNukeConfig.timeWindow * 3
  ));

  return false;
}

// Emergency Mode Trigger
async function triggerEmergencyMode(guild, userId, triggerAction) {
  if (antiNukeConfig.emergencyMode) return; // Already in emergency mode
  
  const now = Date.now();
  // Prevent spam emergency modes (cooldown of 5 minutes)
  if (now - antiNukeData.lastEmergencyMode < 5 * 60 * 1000) return;
  
  antiNukeConfig.emergencyMode = true;
  antiNukeData.lastEmergencyMode = now;
  
  console.log(`🚨🚨 EMERGENCY MODE ACTIVATED: Triggered by ${userId} (${triggerAction})`);
  
  try {
    // Auto-lockdown if enabled
    if (antiNukeConfig.autoLockdown) {
      await lockdownServer(guild);
    }
    
    // Send emergency notification
    if (antiNukeConfig.logChannelId) {
      const logChannel = guild.channels.cache.get(antiNukeConfig.logChannelId);
      if (logChannel) {
        const emergencyEmbed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('🚨🚨 EMERGENCY MODE ACTIVATED 🚨🚨')
          .setDescription('**SEVERE THREAT DETECTED - SERVER IN LOCKDOWN**')
          .addFields(
            { name: '⚠️ Threat Level', value: 'CRITICAL', inline: true },
            { name: '👤 Triggered By', value: `<@${userId}>`, inline: true },
            { name: '🔥 Action', value: triggerAction, inline: true },
            { name: '🛡️ Protection Status', value: 'MAXIMUM SECURITY ACTIVE', inline: false },
            { name: '🔒 Server Status', value: antiNukeConfig.autoLockdown ? 'LOCKED DOWN' : 'MONITORING', inline: true },
            { name: '⏰ Time', value: `<t:${Math.floor(now / 1000)}:F>`, inline: true }
          )
          .setFooter({ text: 'Enhanced Anti-Nuke System • Emergency Response Protocol' })
          .setTimestamp();
        
        await logChannel.send({ 
          content: '@everyone **EMERGENCY SECURITY ALERT**', 
          embeds: [emergencyEmbed] 
        });
      }
    }
    
    // Auto-disable emergency mode after 10 minutes
    setTimeout(() => {
      antiNukeConfig.emergencyMode = false;
      console.log('🟢 Emergency mode automatically disabled after 10 minutes');
    }, 10 * 60 * 1000);
    
  } catch (error) {
    console.error('Error in emergency mode activation:', error);
  }
}

// Server Lockdown Function
async function lockdownServer(guild) {
  try {
    console.log('🔒 INITIATING SERVER LOCKDOWN...');
    
    // Lock all text channels
    const textChannels = guild.channels.cache.filter(channel => channel.type === 0);
    for (const [channelId, channel] of textChannels) {
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, {
          SendMessages: false,
          AddReactions: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false
        });
      } catch (error) {
        console.error(`Failed to lock channel ${channel.name}:`, error);
      }
    }
    
    // Pause all invites
    const invites = await guild.invites.fetch();
    for (const [inviteCode, invite] of invites) {
      try {
        await invite.delete('Emergency lockdown');
      } catch (error) {
        console.error(`Failed to delete invite ${inviteCode}:`, error);
      }
    }
    
    console.log('🔒 SERVER LOCKDOWN COMPLETE - All channels locked, invites paused');
  } catch (error) {
    console.error('Error during server lockdown:', error);
  }
}

async function punishUser(guild, member, action, actionCount) {
  try {
    const logEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚨 ANTI-NUKE TRIGGERED')
      .addFields(
        { name: 'User', value: `${member.user.tag} (${member.id})`, inline: true },
        { name: 'Action', value: action, inline: true },
        { name: 'Count', value: actionCount.toString(), inline: true },
        { name: 'Punishment', value: antiNukeConfig.punishmentType, inline: true },
        { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
      )
      .setTimestamp();

    if (antiNukeConfig.logChannelId) {
      const logChannel = guild.channels.cache.get(antiNukeConfig.logChannelId);
      if (logChannel) {
        await logChannel.send({ embeds: [logEmbed] });
      }
    }

    switch (antiNukeConfig.punishmentType) {
      case 'ban':
        if (guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
          await member.ban({ reason: `Anti-nuke: Exceeded ${action} limit (${actionCount})` });
        }
        break;
      case 'kick':
        if (guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) {
          await member.kick(`Anti-nuke: Exceeded ${action} limit (${actionCount})`);
        }
        break;
      case 'remove_permissions':
        if (guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
          const dangerousPerms = [
            PermissionFlagsBits.Administrator,
            PermissionFlagsBits.ManageGuild,
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.BanMembers,
            PermissionFlagsBits.KickMembers,
            PermissionFlagsBits.ManageMessages
          ];

          for (const role of member.roles.cache.values()) {
            if (role.permissions.any(dangerousPerms) && role.position < guild.members.me.roles.highest.position) {
              try {
                await member.roles.remove(role, `Anti-nuke: Removed dangerous role`);
              } catch (error) {
                console.error('Failed to remove role:', error);
              }
            }
          }
        }
        break;
    }
    console.log(`🚨 Anti-nuke triggered: ${member.user.tag} exceeded ${action} limit`);
  } catch (error) {
    console.error('Anti-nuke punishment error:', error);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration
  ],
});

function createMusicQueue(guildId) {
  if (!musicQueues.has(guildId)) {
    musicQueues.set(guildId, {
      songs: [],
      currentSong: null,
      isPlaying: false,
      volume: 50,
      loop: false
    });
  }
  return musicQueues.get(guildId);
}



// Bot owner verification function
function isBotOwner(userId) {
  const BOT_OWNER_ID = '1327564898460242015';
  return userId === BOT_OWNER_ID;
}

// Prefix command handler
async function handlePrefixCommand(message) {
  try {
    if (!checkCooldown(message.author.id)) {
      return;
    }

    const args = message.content.slice(BOT_PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Check authentication for all commands except auth and unauthenticate
    if (command !== 'auth' && command !== 'unauthenticate' && !isServerAuthenticated(message.guild.id)) {
      await message.reply('**Authentication Required from Script**');
      return;
    }

    switch (command) {
      case 'auth':
        await handleAuthCommand(message, args);
        break;
      
      case 'unauthenticate':
        await handleUnauthenticateCommand(message, args);
        break;
      case 'ping':
        await handlePingCommand(message);
        break;
      
      case 'help':
        await handleHelpCommand(message);
        break;
      
      
      
      case 'image':
      case 'generate':
        await handleImageCommand(message, args);
        break;
      
      case 'gif':
        await handleGifCommand(message, args);
        break;
      
      case 'compliment':
        await handleComplimentCommand(message);
        break;
      
      
      
      case 'say':
        await handleSayCommand(message, args);
        break;
      
      case 'developer':
      case 'dev':
        await handleDeveloperCommand(message);
        break;
      
      case 'serverinfo':
        await handleServerInfoCommand(message);
        break;
      
      case 'userinfo':
        await handleUserInfoCommand(message, args);
        break;
      
      case 'uptime':
        await handleUptimeCommand(message);
        break;

      // New prefix commands
      case 'j':
        await handleJoinVCCommand(message);
        break;
      
      case 'l':
        await handleLeaveVCCommand(message);
        break;
      
      case 'play':
        await handlePlayCommand(message);
        break;
      
      case 'cr':
        await handleClearCommand(message, args);
        break;
      
      case 'dev':
        await handleDevCommand(message);
        break;

      case 'echo':
        await handleEchoCommand(message, args);
        break;

      // Owner-only commands
      case 'k':
        await handleOwnerKickCommand(message, args);
        break;
      
      case 'b':
        await handleOwnerBanCommand(message, args);
        break;
      
      case 't':
        await handleOwnerTimeoutCommand(message, args);
        break;
      
      case 'dm':
        await handleOwnerDMCommand(message, args);
        break;

      
      
      default:
        await message.reply(`❌ Unknown command! Use \`${BOT_PREFIX}help\` to see available commands.`);
        break;
    }
  } catch (error) {
    console.error('Prefix command error:', error);
    await message.reply('❌ An error occurred while processing your command.');
  }
}

// Prefix command functions
async function handlePingCommand(message) {
  const sent = await message.reply('Pinging...');
  const latency = sent.createdTimestamp - message.createdTimestamp;

  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('🏓 Pong!')
    .addFields(
      { name: 'Bot Latency', value: `${latency}ms`, inline: true },
      { name: 'API Latency', value: `${Math.round(client.ws.ping)}ms`, inline: true },
      { name: 'Status', value: '⚡ Enhanced & Fast!', inline: true }
    )
    .setTimestamp();

  await sent.edit({ content: '', embeds: [embed] });
}

async function handleHelpCommand(message) {
  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle(`🤖 Bot Commands - Prefix: ${BOT_PREFIX}`)
    .setDescription('Here are all the available prefix commands:')
    .addFields(
      {
        name: '🎨 Fun Commands',
        value: `• \`${BOT_PREFIX}gif [search]\` - Send random GIFs\n• \`${BOT_PREFIX}say <message>\` - Make bot say something\n• \`${BOT_PREFIX}compliment\` - Get a compliment\n• \`${BOT_PREFIX}ping\` - Check bot latency`,
        inline: false
      },
      {
        name: '📊 Information Commands',
        value: `• \`${BOT_PREFIX}userinfo [user]\` - User information\n• \`${BOT_PREFIX}serverinfo\` - Server information\n• \`${BOT_PREFIX}uptime\` - Bot uptime stats\n• \`${BOT_PREFIX}developer\` - Developer info\n• \`${BOT_PREFIX}dev\` - Show developer info\n• \`${BOT_PREFIX}help\` - Show this menu`,
        inline: false
      },
      {
        name: '🎵 Voice & Music Commands',
        value: `• \`${BOT_PREFIX}j\` - Join your voice channel\n• \`${BOT_PREFIX}l\` - Leave voice channel\n• \`${BOT_PREFIX}play\` - Open local custom compact widget\n• \`${BOT_PREFIX}echo <message> [count]\` - Echo sounds with repetition`,
        inline: false
      },
      {
        name: '🛠️ Utility Commands',
        value: `• \`${BOT_PREFIX}cr <number>\` - Clear messages (1-100)\n• \`${BOT_PREFIX}say <message>\` - Make bot say something`,
        inline: false
      },
      {
        name: '👑 Owner-Only Commands',
        value: `• \`${BOT_PREFIX}k @user [reason]\` - Kick a member\n• \`${BOT_PREFIX}b @user [reason]\` - Ban a member\n• \`${BOT_PREFIX}t @user [reason]\` - Timeout a member (5 mins)\n• \`${BOT_PREFIX}dm @user <message>\` - Send DM to user`,
        inline: false
      },
      {
        name: '⚡ Slash Commands',
        value: 'The bot also supports slash commands! Use `/help` to see all slash commands including music, moderation, and advanced features.',
        inline: false
      }
    )
    .setFooter({ text: `Prefix: ${BOT_PREFIX} • Enhanced Bot with AI, Music & Security` })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}





async function handleGifCommand(message, args) {
  const searchTerm = args.length > 0 ? args.join(' ') : 'funny';
  
  try {
    const gif = await getRandomGif(searchTerm, 'medium');

    if (gif) {
      const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle(`🎭 ${gif.title}`)
        .setImage(gif.url)
        .setFooter({ text: 'Powered by Tenor' });

      await message.reply({ embeds: [embed] });
    } else {
      await message.reply('❌ No GIFs found for that search term.');
    }
  } catch (error) {
    console.error('GIF command error:', error);
    await message.reply('❌ Failed to fetch GIF. Please try again.');
  }
}

async function handleComplimentCommand(message) {
  const compliments = [
    "You're absolutely amazing! ✨",
    "Your positive energy is contagious! 🌟",
    "You have such a kind heart! 💕",
    "You're incredibly talented! 🎯",
    "Your smile could light up the whole room! 😊",
    "You're one of a kind! 🦋",
    "You make the world a better place! 🌍",
    "You're stronger than you know! 💪",
    "Your creativity knows no bounds! 🎨",
    "You're absolutely wonderful! 🌈"
  ];
  const randomCompliment = compliments[Math.floor(Math.random() * compliments.length)];
  await message.reply(randomCompliment);
}



async function handleSayCommand(message, args) {
  if (args.length === 0) {
    await message.reply(`❌ Please provide a message! Usage: \`${BOT_PREFIX}say <your message>\``);
    return;
  }

  const content = args.join(' ');
  
  const bannedWords = ['@everyone', '@here', 'discord.gg', 'http://', 'https://'];
  const lowerContent = content.toLowerCase();
  
  if (bannedWords.some(word => lowerContent.includes(word))) {
    await message.reply('❌ I cannot say messages that contain mentions, links, or inappropriate content.');
    return;
  }

  if (content.length > 1000) {
    await message.reply('❌ Message is too long! Please keep it under 1000 characters.');
    return;
  }

  try {
    await message.delete();
    await message.channel.send(content);
  } catch (error) {
    console.error('Say command error:', error);
    await message.reply('❌ Failed to send the message. Please check my permissions.');
  }
}

async function handleDeveloperCommand(message) {
  const embed = new EmbedBuilder()
    .setColor(0x7289DA)
    .setTitle('👨‍💻 Developer Information')
    .setDescription('This enhanced bot was created by **Script from ScriptSpace**')
    .addFields(
      { name: '👨‍💻 Developer', value: 'Script from ScriptSpace', inline: true },
      { name: '🌐 Support Server', value: '[discord.gg/scriptspace]', inline: true },
      { name: '💻 Language', value: 'JavaScript (Node.js)', inline: true },
      { name: '📚 Libraries', value: 'Discord.js v14, Hercai AI, Tesseract.js', inline: true },
      { name: '⚡ Features', value: 'AI Chat, Music Player, Moderation', inline: true },
      { name: '🤖 Prefix', value: BOT_PREFIX, inline: true }
    )
    .setFooter({ text: 'Enhanced Bot • Made with ❤️ by Script from ScriptSpace' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

async function handleServerInfoCommand(message) {
  const guild = message.guild;
  
  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle(`🏰 Server Information - ${guild.name}`)
    .setThumbnail(guild.iconURL())
    .addFields(
      { name: 'Server Name', value: guild.name, inline: true },
      { name: 'Server ID', value: guild.id, inline: true },
      { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
      { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false },
      { name: 'Members', value: guild.memberCount.toString(), inline: true },
      { name: 'Channels', value: guild.channels.cache.size.toString(), inline: true },
      { name: 'Roles', value: guild.roles.cache.size.toString(), inline: true }
    )
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

async function handleUserInfoCommand(message, args) {
  let targetUser = message.author;
  
  if (args.length > 0) {
    const userMention = args[0];
    if (userMention.startsWith('<@') && userMention.endsWith('>')) {
      const userId = userMention.slice(2, -1).replace('!', '');
      targetUser = await client.users.fetch(userId).catch(() => null);
    }
  }

  if (!targetUser) {
    await message.reply('❌ User not found.');
    return;
  }

  const targetMember = message.guild.members.cache.get(targetUser.id);

  const embed = new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle(`👤 User Information - ${targetUser.tag}`)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: 'Username', value: targetUser.tag, inline: true },
      { name: 'User ID', value: targetUser.id, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:F>`, inline: false }
    );

  if (targetMember) {
    embed.addFields(
      { name: 'Joined Server', value: `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:F>`, inline: false },
      { name: 'Roles', value: targetMember.roles.cache.filter(role => role.id !== message.guild.id).map(role => role.toString()).join(', ') || 'None', inline: false }
    );
  }

  await message.reply({ embeds: [embed] });
}

async function handleUptimeCommand(message) {
  if (uptimeMonitor) {
    await message.reply({ embeds: [uptimeMonitor.getUptimeEmbed()] });
  } else {
    await message.reply('❌ Uptime monitoring is not active.');
  }
}

// Auth command handler for prefix commands
async function handleAuthCommand(message, args) {
  // Strict bot owner verification
  if (!isBotOwner(message.author.id)) {
    await message.reply('❌ **Access Denied:** Only the bot owner can authenticate servers.');
    
    // Log unauthorized attempt
    console.log(`🚨 UNAUTHORIZED AUTH ATTEMPT: ${message.author.tag} (${message.author.id}) tried to authenticate server ${message.guild.name} (${message.guild.id})`);
    return;
  }

  if (args.length === 0) {
    await message.reply(`❌ Please provide the authentication key! Usage: \`${BOT_PREFIX}auth <key>\``);
    return;
  }

  const providedKey = args[0];
  const correctKey = 'KM54928';

  // Strict key validation
  if (providedKey !== correctKey) {
    await message.reply('❌ **Invalid authentication key!** Access denied.');
    
    // Log failed key attempt
    console.log(`🚨 INVALID AUTH KEY: ${message.author.tag} (${message.author.id}) used wrong key "${providedKey}" in server ${message.guild.name}`);
    return;
  }

  // Double verification - check both owner ID and key
  const BOT_OWNER_ID = '1327564898460242015';
  if (message.author.id !== BOT_OWNER_ID) {
    await message.reply('❌ **Security Error:** Owner verification failed.');
    console.log(`🚨 SECURITY BREACH ATTEMPT: Non-owner ${message.author.tag} (${message.author.id}) tried auth with correct key`);
    return;
  }

  // Authenticate the server
  const authenticatedServers = loadAuthenticatedServers();
  authenticatedServers[message.guild.id] = true;
  saveAuthenticatedServers(authenticatedServers);

  // Log successful authentication
  console.log(`✅ SERVER AUTHENTICATED: ${message.guild.name} (${message.guild.id}) by owner ${message.author.tag}`);

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Server Authenticated Successfully')
    .setDescription('All bot commands are now available for use in this server!')
    .addFields(
      { name: '🏰 Server', value: message.guild.name, inline: true },
      { name: '👑 Authenticated by', value: `${message.author.tag} (VERIFIED OWNER)`, inline: true },
      { name: '🔐 Status', value: '✅ Fully Authenticated', inline: true },
      { name: '🔑 Security', value: '✅ Owner ID and key verified', inline: false }
    )
    .setFooter({ text: 'Authentication completed by Script • Security verified' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// Unauthenticate command handler for prefix commands
async function handleUnauthenticateCommand(message, args) {
  // Strict bot owner verification
  if (!isBotOwner(message.author.id)) {
    await message.reply('❌ **Access Denied:** Only the bot owner can unauthenticate servers.');
    
    // Log unauthorized attempt
    console.log(`🚨 UNAUTHORIZED UNAUTH ATTEMPT: ${message.author.tag} (${message.author.id}) tried to unauthenticate server ${message.guild.name} (${message.guild.id})`);
    return;
  }

  if (args.length === 0) {
    await message.reply(`❌ Please provide the authentication key! Usage: \`${BOT_PREFIX}unauthenticate <key>\``);
    return;
  }

  const providedKey = args[0];
  const correctKey = 'KM54928';

  // Strict key validation
  if (providedKey !== correctKey) {
    await message.reply('❌ **Invalid authentication key!** Access denied.');
    
    // Log failed key attempt
    console.log(`🚨 INVALID UNAUTH KEY: ${message.author.tag} (${message.author.id}) used wrong key "${providedKey}" in server ${message.guild.name}`);
    return;
  }

  // Double verification - check both owner ID and key
  const BOT_OWNER_ID = '1327564898460242015';
  if (message.author.id !== BOT_OWNER_ID) {
    await message.reply('❌ **Security Error:** Owner verification failed.');
    console.log(`🚨 SECURITY BREACH ATTEMPT: Non-owner ${message.author.tag} (${message.author.id}) tried unauth with correct key`);
    return;
  }

  // Remove authentication from the server
  const authenticatedServers = loadAuthenticatedServers();
  delete authenticatedServers[message.guild.id];
  saveAuthenticatedServers(authenticatedServers);

  // Log successful unauthentication
  console.log(`🔒 SERVER UNAUTHENTICATED: ${message.guild.name} (${message.guild.id}) by owner ${message.author.tag}`);

  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🔒 Server Authentication Cancelled')
    .setDescription('All bot commands are now blocked in this server!')
    .addFields(
      { name: '🏰 Server', value: message.guild.name, inline: true },
      { name: '👑 Unauthenticated by', value: `${message.author.tag} (VERIFIED OWNER)`, inline: true },
      { name: '🔐 Status', value: '❌ Authentication Removed', inline: true },
      { name: '🚫 Command Access', value: 'All commands now show "Authentication Required from Script"', inline: false },
      { name: '🔑 Re-authentication', value: `Use \`${BOT_PREFIX}auth KM54928\` to re-enable commands`, inline: false },
      { name: '🔑 Security', value: '✅ Owner ID and key verified', inline: false }
    )
    .setFooter({ text: 'Authentication cancelled by Script • Security verified' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// New prefix command handlers
async function handleJoinVCCommand(message) {
  const member = message.member;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await message.reply('❌ You need to be in a voice channel first!');
    return;
  }

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    voiceConnections.set(message.guild.id, connection);

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log('Voice connection ready!');
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      console.log('Voice connection disconnected');
      voiceConnections.delete(message.guild.id);
    });

    await message.reply(`✅ Joined **${voiceChannel.name}**!`);
  } catch (error) {
    console.error('Join voice error:', error);
    await message.reply('❌ Failed to join voice channel. Make sure I have proper permissions.');
  }
}

async function handleLeaveVCCommand(message) {
  const connection = voiceConnections.get(message.guild.id);

  if (!connection) {
    await message.reply('❌ I\'m not connected to any voice channel!');
    return;
  }

  try {
    connection.destroy();
    voiceConnections.delete(message.guild.id);

    // Clear music queue if exists
    const queue = musicQueues.get(message.guild.id);
    if (queue) {
      queue.isPlaying = false;
      queue.currentSong = null;
      queue.songs = [];
    }

    await message.reply('✅ Left the voice channel and cleared music queue!');
  } catch (error) {
    console.error('Leave voice error:', error);
    await message.reply('❌ Failed to leave voice channel.');
  }
}

async function handlePlayCommand(message) {
  let player = localMusicPlayers.get(message.guild.id);
  if (!player) {
    player = new LocalMusicPlayer();
    localMusicPlayers.set(message.guild.id, player);
    player.loadPlaylist();
  }

  const widget = player.getCompactWidgetWithTrackSelection();
  await message.reply({ 
    content: '🎵 **Local Custom Compact Widget**\n\n**Features:**\n• 🎮 Essential playback controls\n• 🎵 Quick track selection buttons\n• 📱 Compact design for mobile\n• ⚡ Instant song switching\n\n**Usage:** Click any track button below to instantly switch to that song!',
    embeds: widget.embeds, 
    components: widget.components 
  });
}

async function handleClearCommand(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await message.reply('❌ You need the "Manage Messages" permission to use this command.');
    return;
  }

  if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await message.reply('❌ I need the "Manage Messages" permission to perform this action.');
    return;
  }

  const amount = parseInt(args[0]);
  
  if (!amount || amount < 1 || amount > 100) {
    await message.reply('❌ Please provide a valid number between 1 and 100.');
    return;
  }

  try {
    const messages = await message.channel.messages.fetch({ limit: amount + 1 });
    const deletedMessages = await message.channel.bulkDelete(messages, true);
    
    const embed = new EmbedBuilder()
      .setColor(0x00AE86)
      .setTitle('🧹 Messages Cleared')
      .addFields(
        { name: 'Messages Deleted', value: `${deletedMessages.size}`, inline: true },
        { name: 'Moderator', value: `${message.author.tag}`, inline: true },
        { name: 'Channel', value: `${message.channel.name}`, inline: true }
      )
      .setTimestamp();

    const confirmMessage = await message.channel.send({ embeds: [embed] });
    
    // Delete the confirmation message after 5 seconds
    setTimeout(() => {
      confirmMessage.delete().catch(() => {});
    }, 5000);
  } catch (error) {
    console.error('Clear error:', error);
    await message.reply('❌ Failed to delete messages. Messages older than 14 days cannot be bulk deleted.');
  }
}

async function handleDevCommand(message) {
  await message.reply('**Made by script : discord.gg/scriptspace**');
}

async function handleEchoCommand(message, args) {
  if (args.length === 0) {
    await message.reply(`❌ Please provide a message to echo! Usage: \`${BOT_PREFIX}echo <message> [repeat_count]\``);
    return;
  }

  const connection = voiceConnections.get(message.guild.id);
  if (!connection) {
    await message.reply('❌ I need to be in a voice channel first! Use `S!j` to join.');
    return;
  }

  // Parse arguments - last argument might be repeat count if it's a number
  let echoMessage = args.join(' ');
  let repeatCount = 3; // default

  const lastArg = args[args.length - 1];
  if (!isNaN(lastArg) && parseInt(lastArg) > 0 && parseInt(lastArg) <= 10) {
    repeatCount = parseInt(lastArg);
    echoMessage = args.slice(0, -1).join(' ');
  }

  if (echoMessage.length > 150) {
    await message.reply('❌ Echo message is too long! Please keep it under 150 characters.');
    return;
  }

  try {
    const loadingMessage = await message.reply(`🔊 **Starting Echo Sequence**\n\n**Message:** "${echoMessage}"\n**Repeats:** ${repeatCount}\n**Delay:** 2 seconds\n\n🔄 Generating audio...`);

    // Generate TTS audio
    const audioUrl = await textToSpeech(echoMessage, 'female');
    
    if (!audioUrl) {
      await loadingMessage.edit('❌ Failed to generate echo audio.');
      return;
    }

    await loadingMessage.edit(`🔊 **Echo Started!**\n\n**Message:** "${echoMessage}"\n**Repeats:** ${repeatCount}\n**Status:** 🟢 Playing echo sequence...`);

    // Create audio player for echo
    const echoPlayer = createAudioPlayer();
    connection.subscribe(echoPlayer);

    let currentRepeat = 0;
    const startTime = Date.now();

    const playPrefixEcho = async () => {
      if (currentRepeat >= repeatCount) {
        const duration = Math.floor((Date.now() - startTime) / 1000);
        await loadingMessage.edit(`✅ **Echo Completed!**\n\n**Message:** "${echoMessage}"\n**Repeats:** ${repeatCount}\n**Duration:** ${duration} seconds\n**Status:** 🔴 Finished`);
        return;
      }

      currentRepeat++;
      console.log(`Prefix echo ${currentRepeat}/${repeatCount}: "${echoMessage}"`);

      try {
        const echoAudioUrl = await textToSpeech(echoMessage, 'female');
        
        if (echoAudioUrl) {
          const echoResource = createAudioResource(echoAudioUrl);
          echoPlayer.play(echoResource);

          echoPlayer.once(AudioPlayerStatus.Idle, () => {
            if (currentRepeat < repeatCount) {
              setTimeout(() => {
                playPrefixEcho();
              }, 2000); // 2 second delay
            } else {
              playPrefixEcho(); // Final call to trigger completion
            }
          });
        } else {
          setTimeout(() => {
            playPrefixEcho();
          }, 2000);
        }
      } catch (error) {
        console.error('Prefix echo error:', error);
        setTimeout(() => {
          playPrefixEcho();
        }, 2000);
      }
    };

    echoPlayer.on('error', (error) => {
      console.error('Prefix echo player error:', error);
    });

    // Start echo sequence
    playPrefixEcho();

  } catch (error) {
    console.error('Prefix echo command error:', error);
    await message.reply('❌ Failed to start echo sequence.');
  }
}

// Owner-only prefix command handlers
async function handleOwnerKickCommand(message, args) {
  if (!isBotOwner(message.author.id)) {
    await message.reply('❌ This command can only be used by the bot owner.');
    return;
  }

  if (!message.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) {
    await message.reply('❌ I need the "Kick Members" permission to perform this action.');
    return;
  }

  if (args.length === 0) {
    await message.reply(`❌ Please mention a user to kick! Usage: \`${BOT_PREFIX}k @user [reason]\``);
    return;
  }

  const userMention = args[0];
  const reason = args.slice(1).join(' ') || 'No reason provided';

  if (!userMention.startsWith('<@') || !userMention.endsWith('>')) {
    await message.reply('❌ Please mention a valid user to kick.');
    return;
  }

  const userId = userMention.slice(2, -1).replace('!', '');
  const targetMember = message.guild.members.cache.get(userId);

  if (!targetMember) {
    await message.reply('❌ User not found in this server.');
    return;
  }

  if (targetMember.id === message.author.id) {
    await message.reply('❌ You cannot kick yourself.');
    return;
  }

  if (targetMember.id === client.user.id) {
    await message.reply('❌ I cannot kick myself.');
    return;
  }

  if (targetMember.roles.highest.position >= message.guild.members.me.roles.highest.position) {
    await message.reply('❌ I cannot kick someone with equal or higher roles than me.');
    return;
  }

  try {
    await targetMember.kick(reason);
    const embed = new EmbedBuilder()
      .setColor(0xFF6B35)
      .setTitle('👢 Member Kicked (Owner Command)')
      .addFields(
        { name: 'User', value: `${targetMember.user.tag} (${targetMember.user.id})`, inline: true },
        { name: 'Owner', value: `${message.author.tag}`, inline: true },
        { name: 'Reason', value: reason, inline: false }
      )
      .setTimestamp();
    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Owner kick error:', error);
    await message.reply('❌ Failed to kick the user. Check my permissions and role hierarchy.');
  }
}

async function handleOwnerBanCommand(message, args) {
  if (!isBotOwner(message.author.id)) {
    await message.reply('❌ This command can only be used by the bot owner.');
    return;
  }

  if (!message.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
    await message.reply('❌ I need the "Ban Members" permission to perform this action.');
    return;
  }

  if (args.length === 0) {
    await message.reply(`❌ Please mention a user to ban! Usage: \`${BOT_PREFIX}b @user [reason]\``);
    return;
  }

  const userMention = args[0];
  const reason = args.slice(1).join(' ') || 'No reason provided';

  if (!userMention.startsWith('<@') || !userMention.endsWith('>')) {
    await message.reply('❌ Please mention a valid user to ban.');
    return;
  }

  const userId = userMention.slice(2, -1).replace('!', '');
  const targetMember = message.guild.members.cache.get(userId);

  if (targetMember) {
    if (targetMember.id === message.author.id) {
      await message.reply('❌ You cannot ban yourself.');
      return;
    }

    if (targetMember.id === client.user.id) {
      await message.reply('❌ I cannot ban myself.');
      return;
    }

    if (targetMember.roles.highest.position >= message.guild.members.me.roles.highest.position) {
      await message.reply('❌ I cannot ban someone with equal or higher roles than me.');
      return;
    }
  }

  try {
    await message.guild.members.ban(userId, { deleteMessageDays: 0, reason: reason });
    const embed = new EmbedBuilder()
      .setColor(0xDC143C)
      .setTitle('🔨 Member Banned (Owner Command)')
      .addFields(
        { name: 'User', value: targetMember ? `${targetMember.user.tag} (${targetMember.user.id})` : `User ID: ${userId}`, inline: true },
        { name: 'Owner', value: `${message.author.tag}`, inline: true },
        { name: 'Reason', value: reason, inline: false }
      )
      .setTimestamp();
    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Owner ban error:', error);
    await message.reply('❌ Failed to ban the user. Check my permissions and role hierarchy.');
  }
}

async function handleOwnerTimeoutCommand(message, args) {
  if (!isBotOwner(message.author.id)) {
    await message.reply('❌ This command can only be used by the bot owner.');
    return;
  }

  if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await message.reply('❌ I need the "Moderate Members" permission to perform this action.');
    return;
  }

  if (args.length === 0) {
    await message.reply(`❌ Please mention a user to timeout! Usage: \`${BOT_PREFIX}t @user [reason]\``);
    return;
  }

  const userMention = args[0];
  const reason = args.slice(1).join(' ') || 'No reason provided';

  if (!userMention.startsWith('<@') || !userMention.endsWith('>')) {
    await message.reply('❌ Please mention a valid user to timeout.');
    return;
  }

  const userId = userMention.slice(2, -1).replace('!', '');
  let targetMember;
  
  try {
    targetMember = await message.guild.members.fetch(userId);
  } catch (error) {
    await message.reply('❌ User not found in this server.');
    return;
  }

  if (targetMember.id === message.author.id) {
    await message.reply('❌ You cannot timeout yourself.');
    return;
  }

  if (targetMember.id === client.user.id) {
    await message.reply('❌ I cannot timeout myself.');
    return;
  }

  if (targetMember.id === message.guild.ownerId) {
    await message.reply('❌ You cannot timeout the server owner.');
    return;
  }

  if (targetMember.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply('❌ You cannot timeout a user with Administrator permissions.');
    return;
  }

  if (targetMember.roles.highest.position >= message.guild.members.me.roles.highest.position) {
    await message.reply('❌ I cannot timeout someone with equal or higher roles than me.');
    return;
  }

  if (targetMember.isCommunicationDisabled()) {
    await message.reply('❌ This user is already timed out.');
    return;
  }

  try {
    const timeoutDuration = 5 * 60 * 1000; // 5 minutes in milliseconds
    await targetMember.timeout(timeoutDuration, reason);

    const timeoutEnd = new Date(Date.now() + timeoutDuration);

    const embed = new EmbedBuilder()
      .setColor(0xFFA500)
      .setTitle('⏰ Member Timed Out (Owner Command)')
      .addFields(
        { name: '👤 User', value: `${targetMember.user.tag}\n\`${targetMember.user.id}\``, inline: true },
        { name: '⏱️ Duration', value: '5 minutes', inline: true },
        { name: '👑 Owner', value: `${message.author.tag}`, inline: true },
        { name: '📝 Reason', value: reason, inline: false },
        { name: '⏰ Timeout Ends', value: `<t:${Math.floor(timeoutEnd.getTime() / 1000)}:F>`, inline: false }
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });

    // Try to send DM to the user
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('⏰ You have been timed out')
        .addFields(
          { name: 'Server', value: message.guild.name, inline: true },
          { name: 'Duration', value: '5 minutes', inline: true },
          { name: 'Reason', value: reason, inline: false },
          { name: 'Timeout Ends', value: `<t:${Math.floor(timeoutEnd.getTime() / 1000)}:F>`, inline: false }
        )
        .setTimestamp();

      await targetMember.user.send({ embeds: [dmEmbed] });
    } catch (dmError) {
      console.log(`Could not send timeout DM to ${targetMember.user.tag}`);
    }

  } catch (error) {
    console.error('Owner timeout error:', error);
    await message.reply('❌ Failed to timeout the user. Check my permissions and role hierarchy.');
  }
}

async function handleOwnerDMCommand(message, args) {
  if (!isBotOwner(message.author.id)) {
    await message.reply('❌ This command can only be used by the bot owner.');
    return;
  }

  if (args.length < 2) {
    await message.reply(`❌ Please provide a user and message! Usage: \`${BOT_PREFIX}dm @user your message here\``);
    return;
  }

  const userMention = args[0];
  const dmMessage = args.slice(1).join(' ');

  if (!userMention.startsWith('<@') || !userMention.endsWith('>')) {
    await message.reply('❌ Please mention a valid user to send a DM to.');
    return;
  }

  const userId = userMention.slice(2, -1).replace('!', '');
  
  try {
    const targetUser = await client.users.fetch(userId);

    if (targetUser.bot) {
      await message.reply('❌ You cannot send DMs to bots.');
      return;
    }

    if (targetUser.id === message.author.id) {
      await message.reply('❌ You cannot send a DM to yourself.');
      return;
    }

    await targetUser.send(`**Message from bot owner:**\n\n${dmMessage}`);

    const embed = new EmbedBuilder()
      .setColor(0x00AE86)
      .setTitle('✅ DM Sent Successfully (Owner Command)')
      .addFields(
        { name: 'Recipient', value: `${targetUser.tag}`, inline: true },
        { name: 'Message Length', value: `${dmMessage.length} characters`, inline: true },
        { name: 'Sent By', value: `${message.author.tag} (Owner)`, inline: true }
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });

  } catch (error) {
    console.error('Owner DM error:', error);
    await message.reply('❌ Failed to send DM. The user may not exist, have DMs disabled, or have blocked the bot.');
  }
}







// Slash commands with fixed moderation commands
const commands = [
  new SlashCommandBuilder()
    .setName('imageprompt')
    .setDescription('Generate an image from a text prompt')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('The text prompt to generate an image from')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency and response time'),
  new SlashCommandBuilder()
    .setName('gif')
    .setDescription('Send a random GIF')
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Search term for the GIF')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('compliment')
    .setDescription('Get a sweet compliment! 💕'),
  
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands and their descriptions'),
  new SlashCommandBuilder()
    .setName('developer')
    .setDescription('Show information about the bot developer'),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Make the bot say something with media support')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('The message you want the bot to say')
        .setRequired(true))
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to send the message to (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('link')
        .setDescription('Link to include in the message')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('embed')
        .setDescription('Send as an embed (optional)')
        .setRequired(false))
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('Image to send with the message')
        .setRequired(false))
    .addAttachmentOption(option =>
      option.setName('video')
        .setDescription('Video to send with the message')
        .setRequired(false))
    .addAttachmentOption(option =>
      option.setName('file')
        .setDescription('File to send with the message')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('greet')
    .setDescription('Greet a user with a customizable message')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to greet')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Custom greeting message (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('style')
        .setDescription('Greeting style')
        .setRequired(false)
        .addChoices(
          { name: '👋 Friendly', value: 'friendly' },
          { name: '🎉 Excited', value: 'excited' },
          { name: '💼 Professional', value: 'professional' },
          { name: '🌟 Welcoming', value: 'welcoming' },
          { name: '🎮 Gaming', value: 'gaming' },
          { name: '🚀 Motivational', value: 'motivational' }
        ))
    .addBooleanOption(option =>
      option.setName('mention')
        .setDescription('Mention the user in the greeting')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('embed')
        .setDescription('Send as a rich embed')
        .setRequired(false)),

  // Fixed Moderation Commands</old_str>

  // Fixed Moderation Commands
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to kick')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the kick')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to ban')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the ban')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('days')
        .setDescription('Delete messages from the last X days (0-7)')
        .setMinValue(0)
        .setMaxValue(7)
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user from the server')
    .addStringOption(option =>
      option.setName('userid')
        .setDescription('The user ID to unban')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the unban')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to timeout')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('Select timeout duration')
        .setRequired(true)
        .addChoices(
          { name: '1 minute', value: '1' },
          { name: '5 minutes', value: '5' },
          { name: '10 minutes', value: '10' },
          { name: '1 hour', value: '60' },
          { name: '5 hours', value: '300' },
          { name: '7 days', value: '10080' },
          { name: '1 month', value: '43200' }
        ))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the timeout')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Remove timeout from a member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to remove timeout from')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for removing timeout')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to warn')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the warning')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete multiple messages')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Number of messages to delete (1-100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true))
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Only delete messages from this user')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Lock a channel (prevent members from sending messages)')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to lock (defaults to current channel)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for locking the channel')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock a channel')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to unlock (defaults to current channel)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for unlocking the channel')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set slowmode for a channel')
    .addIntegerOption(option =>
      option.setName('seconds')
        .setDescription('Slowmode duration in seconds (0-21600, 0 to disable)')
        .setMinValue(0)
        .setMaxValue(21600)
        .setRequired(true))
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to apply slowmode (defaults to current channel)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Get information about a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to get info about')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Get information about the server'),
  new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Configure anti-nuke settings')
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Check anti-nuke status'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('toggle')
        .setDescription('Enable or disable anti-nuke')
        .addBooleanOption(option =>
          option.setName('enabled')
            .setDescription('Enable or disable anti-nuke')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('whitelist')
        .setDescription('Add user to whitelist')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to whitelist')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('unwhitelist')
        .setDescription('Remove user from whitelist')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to remove from whitelist')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('logchannel')
        .setDescription('Set anti-nuke log channel')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel for anti-nuke logs')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('punishment')
        .setDescription('Set punishment type')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Punishment type')
            .setRequired(true)
            .addChoices(
              { name: 'Ban', value: 'ban' },
              { name: 'Kick', value: 'kick' },
              { name: 'Remove Permissions', value: 'remove_permissions' }
            )))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel'),
  new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Text-to-speech in voice channel')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Message to speak')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('voice')
        .setDescription('Voice type')
        .setRequired(false)
        .addChoices(
          { name: 'Male', value: 'male' },
          { name: 'Female', value: 'female' }
        )),

  new SlashCommandBuilder()
    .setName('echo')
    .setDescription('Echo/repeat sounds in voice channel with customizable repetition')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Message to echo')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('repeat')
        .setDescription('Number of times to repeat (1-10)')
        .setMinValue(1)
        .setMaxValue(10)
        .setRequired(false))
    .addStringOption(option =>
      option.setName('voice')
        .setDescription('Voice type for echo')
        .setRequired(false)
        .addChoices(
          { name: 'Male', value: 'male' },
          { name: 'Female', value: 'female' }
        ))
    .addIntegerOption(option =>
      option.setName('delay')
        .setDescription('Delay between echoes in seconds (1-5)')
        .setMinValue(1)
        .setMaxValue(5)
        .setRequired(false)),

  // Local Music Player Commands
  new SlashCommandBuilder()
    .setName('localplay')
    .setDescription('Play local music files')
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Search for a song (optional)')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('track')
        .setDescription('Track number to play')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('localpause')
    .setDescription('Pause/resume local music playback'),
  new SlashCommandBuilder()
    .setName('localnext')
    .setDescription('Skip to next track'),
  new SlashCommandBuilder()
    .setName('localprevious')
    .setDescription('Go to previous track'),
  new SlashCommandBuilder()
    .setName('localvolume')
    .setDescription('Control local music volume')
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set volume level')
        .addIntegerOption(option =>
          option.setName('level')
            .setDescription('Volume level (0-100)')
            .setMinValue(0)
            .setMaxValue(100)
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('up')
        .setDescription('Increase volume'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('down')
        .setDescription('Decrease volume')),
  new SlashCommandBuilder()
    .setName('localloop')
    .setDescription('Toggle loop mode for local music'),
  new SlashCommandBuilder()
    .setName('localshuffle')
    .setDescription('Toggle shuffle mode for local music'),
  new SlashCommandBuilder()
    .setName('localnowplaying')
    .setDescription('Show currently playing local track'),
  new SlashCommandBuilder()
    .setName('localplaylist')
    .setDescription('Show local music playlist')
    .addIntegerOption(option =>
      option.setName('page')
        .setDescription('Page number')
        .setMinValue(1)
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('localstats')
    .setDescription('Show local music player statistics'),
  new SlashCommandBuilder()
    .setName('localplaylist-play')
    .setDescription('Select and play from different playlists')
    .addStringOption(option =>
      option.setName('playlist')
        .setDescription('Choose a playlist to play')
        .setRequired(true)
        .addChoices(
          { name: '🎵 All Music (Complete Library)', value: 'all' },
          { name: '🎸 Rock & Pop', value: 'rock' },
          { name: '🎭 Tamil Songs', value: 'tamil' },
          { name: '🎤 English Songs', value: 'english' },
          { name: '🎬 Movie Soundtracks', value: 'movies' },
          { name: '🔀 Shuffle All', value: 'shuffle' },
          { name: '⭐ Favorites (A-K)', value: 'favorites_ak' },
          { name: '⭐ Favorites (L-Z)', value: 'favorites_lz' },
          { name: '📝 My Custom Playlists', value: 'custom' }
        ))
    .addStringOption(option =>
      option.setName('custom_playlist')
        .setDescription('Select your custom playlist (only when "My Custom Playlists" is chosen)')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('shuffle')
        .setDescription('Enable shuffle mode for the playlist')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('loop')
        .setDescription('Enable loop mode for continuous playback')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('uptime')
    .setDescription('Show bot uptime and monitoring statistics'),
  new SlashCommandBuilder()
    .setName('localwidget')
    .setDescription('Show the local music player control widget'),
  new SlashCommandBuilder()
    .setName('localcustomwidget')
    .setDescription('Show the custom music player control widget with rectangle display'),
  new SlashCommandBuilder()
    .setName('pladd')
    .setDescription('Add track to playlist')
    .addStringOption(option =>
      option.setName('playlist')
        .setDescription('Playlist name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Search term (optional)')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('track')
        .setDescription('Track number (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('paddmulti')
    .setDescription('Add multiple tracks to playlist')
    .addStringOption(option =>
      option.setName('playlist')
        .setDescription('Playlist name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('tracks')
        .setDescription('Track numbers: 1,3,5,7')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('show_list')
        .setDescription('Show track list')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('paddall')
    .setDescription('Add all tracks to playlist')
    .addStringOption(option =>
      option.setName('playlist')
        .setDescription('Playlist name')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('confirm')
        .setDescription('Confirm add all')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('prename')
    .setDescription('Rename playlist')
    .addStringOption(option =>
      option.setName('old_name')
        .setDescription('Current name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('new_name')
        .setDescription('New name')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('pplay')
    .setDescription('Play custom playlist with optional search')
    .addStringOption(option =>
      option.setName('playlist')
        .setDescription('Playlist name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Search within playlist')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('shuffle')
        .setDescription('Shuffle mode')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('loop')
        .setDescription('Loop mode')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('plist')
    .setDescription('View all playlists'),
  new SlashCommandBuilder()
    .setName('pnow')
    .setDescription('Show playlist now playing'),

  new SlashCommandBuilder()
    .setName('pfix')
    .setDescription('Fix/update playlist')
    .addStringOption(option =>
      option.setName('playlist')
        .setDescription('Playlist to fix')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('add_all_music')
        .setDescription('Replace with all music')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('localcompactwidget')
    .setDescription('Show compact music player widget with track selection buttons'),

  new SlashCommandBuilder()
    .setName('localminimalwidget')
    .setDescription('Show minimal music player widget with track selection'),

  // Icon Management Commands
  new SlashCommandBuilder()
    .setName('iconupload')
    .setDescription('Upload custom icons for the music player')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of icon to upload')
        .setRequired(true)
        .addChoices(
          { name: '▶️ Play Button', value: 'play' },
          { name: '⏸️ Pause Button', value: 'pause' },
          { name: '⏮️ Previous Button', value: 'previous' },
          { name: '⏭️ Next Button', value: 'next' },
          { name: '🔉 Volume Down', value: 'volumeDown' },
          { name: '🔊 Volume Up', value: 'volumeUp' },
          { name: '🔁 Loop Button', value: 'loop' },
          { name: '🔀 Shuffle Button', value: 'shuffle' },
          { name: '⏹️ Stop Button', value: 'stop' },
          { name: '🔄 Refresh Button', value: 'refresh' }
        ))
    .addAttachmentOption(option =>
      option.setName('icon')
        .setDescription('Icon file (PNG, JPG, JPEG, GIF, WEBP - Max 2MB)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Icon category for organization')
        .setRequired(false)
        .addChoices(
          { name: '🔘 Buttons', value: 'buttons' },
          { name: '🖼️ Backgrounds', value: 'backgrounds' },
          { name: '🎬 Animations', value: 'animations' }
        )),

  new SlashCommandBuilder()
    .setName('iconmanager')
    .setDescription('Manage custom music player icons'),

  new SlashCommandBuilder()
    .setName('iconremove')
    .setDescription('Remove a custom icon and reset to default')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of icon to remove')
        .setRequired(true)
        .addChoices(
          { name: '▶️ Play Button', value: 'play' },
          { name: '⏸️ Pause Button', value: 'pause' },
          { name: '⏮️ Previous Button', value: 'previous' },
          { name: '⏭️ Next Button', value: 'next' },
          { name: '🔉 Volume Down', value: 'volumeDown' },
          { name: '🔊 Volume Up', value: 'volumeUp' },
          { name: '🔁 Loop Button', value: 'loop' },
          { name: '🔀 Shuffle Button', value: 'shuffle' },
          { name: '⏹️ Stop Button', value: 'stop' },
          { name: '🔄 Refresh Button', value: 'refresh' }
        )),

  new SlashCommandBuilder()
    .setName('icongallery')
    .setDescription('View all uploaded custom icons')
    .addIntegerOption(option =>
      option.setName('page')
        .setDescription('Page number to view')
        .setMinValue(1)
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the bot (Admin only)')
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for restart (optional)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('auth')
    .setDescription('Authenticate server for bot usage (Owner only)')
    .addStringOption(option =>
      option.setName('key')
        .setDescription('Authentication key')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('unauthenticate')
    .setDescription('Cancel server authentication and block all commands (Owner only)')
    .addStringOption(option =>
      option.setName('key')
        .setDescription('Authentication key')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('aistart')
    .setDescription('Enable AI chat responses for this server (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('aistop')
    .setDescription('Disable AI chat responses for this server (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('aistatus')
    .setDescription('Check AI chat status for this server (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('iconupdate')
    .setDescription('Auto-update and refresh all custom icons')
    .addBooleanOption(option =>
      option.setName('force')
        .setDescription('Force refresh all icons from filesystem')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('scan_new')
        .setDescription('Scan for new icon files in folders')
        .setRequired(false)),

  // Enhanced Voice Channel Moving Command with continuous movement
  new SlashCommandBuilder()
    .setName('vcmove')
    .setDescription('Move a user continuously between voice channels until stopped')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to move continuously')
        .setRequired(true))
    .addChannelOption(option =>
      option.setName('channel1')
        .setDescription('First voice channel (required)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('speed')
        .setDescription('Movement speed interval')
        .setRequired(true)
        .addChoices(
          { name: '🚀 Ultra (0.5s)', value: 'ultra' },
          { name: '⚡ Fast (1s)', value: 'fast' },
          { name: '🏃 Medium (2s)', value: 'medium' },
          { name: '🚶 Slow (4s)', value: 'slow' }
        ))
    .addChannelOption(option =>
      option.setName('channel2')
        .setDescription('Second voice channel (optional, required if all_channels is false)')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('all_channels')
        .setDescription('Move through ALL voice channels in the server')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers),

  new SlashCommandBuilder()
    .setName('vcmovestop')
    .setDescription('Stop continuous voice channel movement for a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to stop moving (optional - stops all if not specified)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers),
  
  // Enhanced DM Commands with full functionality
  
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('Send a direct message to a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to send the message to')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('The message to send (supports emojis and formatting)')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('anonymous')
        .setDescription('Send the message anonymously')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('urgent')
        .setDescription('Mark as urgent message')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('reply_channel')
        .setDescription('Channel ID where replies should be forwarded')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('dmlink')
    .setDescription('Send a link via direct message to a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to send the link to')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('link')
        .setDescription('The link to send (http:// or https://)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Message to include with the link')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Custom title for the link preview')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('anonymous')
        .setDescription('Send anonymously')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('preview')
        .setDescription('Enable link preview embed')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('dmimage')
    .setDescription('Send an image via direct message to a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to send the image to')
        .setRequired(true))
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('The image file to send (PNG, JPG, GIF, WEBP)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Caption for the image')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('alt_text')
        .setDescription('Alternative text for accessibility')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('anonymous')
        .setDescription('Send anonymously')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('spoiler')
        .setDescription('Mark image as spoiler')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('dmvideo')
    .setDescription('Send a video via direct message to a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to send the video to')
        .setRequired(true))
    .addAttachmentOption(option =>
      option.setName('video')
        .setDescription('The video file to send (MP4, MOV, AVI, WEBM)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Caption for the video')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('thumbnail')
        .setDescription('Custom thumbnail URL (optional)')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('anonymous')
        .setDescription('Send anonymously')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('spoiler')
        .setDescription('Mark video as spoiler')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('dmembed')
    .setDescription('Send a rich embed message via direct message')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to send the embed to')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('title')
        .setDescription('The embed title')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('description')
        .setDescription('The embed description (supports markdown)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('color')
        .setDescription('Embed color (hex code without #, e.g., FF0000)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('image_url')
        .setDescription('Large image URL for the embed')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('thumbnail_url')
        .setDescription('Small thumbnail image URL')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('footer_text')
        .setDescription('Footer text for the embed')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('author_name')
        .setDescription('Author name in embed header')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('anonymous')
        .setDescription('Send anonymously')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('timestamp')
        .setDescription('Add current timestamp to embed')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('dmfile')
    .setDescription('Send any file via direct message to a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to send the file to')
        .setRequired(true))
    .addAttachmentOption(option =>
      option.setName('file')
        .setDescription('The file to send (any type, max 8MB)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Message to include with the file')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('filename')
        .setDescription('Custom filename (keeps original extension)')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('anonymous')
        .setDescription('Send anonymously')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('dmbulk')
    .setDescription('Send a message to multiple users at once')
    .addStringOption(option =>
      option.setName('users')
        .setDescription('User IDs separated by commas (e.g., 123456789,987654321)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('The message to send to all users')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('anonymous')
        .setDescription('Send anonymously to all users')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('delay')
        .setDescription('Delay between messages in seconds (1-10)')
        .setMinValue(1)
        .setMaxValue(10)
        .setRequired(false)),

  // Sticky Note Commands
  new SlashCommandBuilder()
    .setName('sticknote')
    .setDescription('Create an enhanced sticky message with image/GIF link support, persistent at bottom')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Title for the sticky note')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('text')
        .setDescription('Content text for the sticky note')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('image_link')
        .setDescription('Direct link to image or GIF (supports Tenor, Giphy, Imgur, Discord CDN)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('author')
        .setDescription('Custom author name for the sticky note')
        .setRequired(false))
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('Upload image or GIF file (PNG, JPG, GIF, WEBP)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('thumbnail')
        .setDescription('Thumbnail URL for the sticky note')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('color')
        .setDescription('Hex color code (without #, e.g., FF0000 for red)')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('persistent')
        .setDescription('Auto-repost if deleted and keep at bottom (default: true)')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('all_channels')
        .setDescription('Deploy sticky note to ALL text channels in the server')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('additional_link')
        .setDescription('Additional link to include (website, video, etc.)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('removesticknote')
    .setDescription('Remove the sticky note from this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('liststicknotes')
    .setDescription('List all active sticky notes in this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('updatesticknote')
    .setDescription('Update the existing sticky note in this channel')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('New title for the sticky note')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('text')
        .setDescription('New content text for the sticky note')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('author')
        .setDescription('New author name for the sticky note')
        .setRequired(false))
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('New image or GIF to include')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('thumbnail')
        .setDescription('New thumbnail URL for the sticky note')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('color')
        .setDescription('New hex color code (without #)')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('persistent')
        .setDescription('Auto-repost if deleted')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  // Separate Edit Commands for Sticky Notes
  new SlashCommandBuilder()
    .setName('editstickytitle')
    .setDescription('Edit only the title of the sticky note in this channel')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('New title for the sticky note')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('editstickytext')
    .setDescription('Edit only the text content of the sticky note in this channel')
    .addStringOption(option =>
      option.setName('text')
        .setDescription('New text content for the sticky note')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('editstickyauthor')
    .setDescription('Edit only the author of the sticky note in this channel')
    .addStringOption(option =>
      option.setName('author')
        .setDescription('New author name for the sticky note (leave empty to remove)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('editstickyimage')
    .setDescription('Edit only the image of the sticky note in this channel')
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('New image or GIF (PNG, JPG, GIF, WEBP) - leave empty to remove')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('editstickythumbnail')
    .setDescription('Edit only the thumbnail of the sticky note in this channel')
    .addStringOption(option =>
      option.setName('thumbnail')
        .setDescription('New thumbnail URL - leave empty to remove')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('editstickycolor')
    .setDescription('Edit only the color of the sticky note in this channel')
    .addStringOption(option =>
      option.setName('color')
        .setDescription('New hex color code (without #, e.g., FF0000) - leave empty for default')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('editstickypersistent')
    .setDescription('Toggle the persistent mode of the sticky note in this channel')
    .addBooleanOption(option =>
      option.setName('persistent')
        .setDescription('Enable or disable auto-repost when deleted')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('listglobalstickynotes')
    .setDescription('List all global sticky notes deployed across channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('removeglobalstickynote')
    .setDescription('Remove a global sticky note from all channels by title')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Title of the global sticky note to remove')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  

  
];

// Enhanced GIF API
async function getRandomGif(searchTerm = "funny", contentFilter = "medium") {
  try {
    const fetch = (await import('node-fetch')).default;
    const query = searchTerm || "funny";
    const url = `${TENOR_BASE_URL}?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&client_key=discord_bot&limit=20&contentfilter=${contentFilter}`;
    const response = await fetch(url, { timeout: 10000 });
    if (!response.ok) throw new Error('Failed to fetch GIF');
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      throw new Error('No GIFs found');
    }
    const randomGif = data.results[Math.floor(Math.random() * data.results.length)];
    return {
      url: randomGif.media_formats.gif.url,
      title: randomGif.content_description || query
    };
  } catch (error) {
    console.error('GIF API Error:', error);
    return null;
  }
}

// Enhanced Text-to-Speech function
async function textToSpeech(text, voice = 'female') {
  try {
    const fetch = (await import('node-fetch')).default;
    const voiceCode = voice === 'male' ? 'en-US-Wavenet-J' : 'en-US-Wavenet-C';
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=${voiceCode}&text=${encodeURIComponent(text)}`;

    const response = await fetch(url, { timeout: 10000 });
    if (!response.ok) throw new Error('TTS API failed');

    return response.url;
  } catch (error) {
    console.error('TTS Error:', error);
    return null;
  }
}

client.once("ready", async () => {
  try {
    console.log(`🤖 Bot is ready! ${client.user.tag}`);
    console.log(`📊 Servers: ${client.guilds.cache.size}`);
    console.log(`👥 Users: ${client.users.cache.size}`);
    console.log(`Code by Script Studio • discord.gg/scriptspace`);

    // Load sticky notes
    loadStickyNotes();
    loadGlobalStickyNotes();

    // Initialize uptime monitor
    uptimeMonitor = new UptimeMonitor(client);

    // Initialize keep-alive service
    keepAliveService = new KeepAliveService();
    keepAliveService.start();

    client.user.setPresence({
      activities: [{ name: 'Enhanced AI Assistant with Local Music!', type: 3 }],
      status: 'online',
    });

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
      console.log('🔄 Started refreshing application (/) commands...');
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands },
      );
      console.log('✅ Successfully reloaded application (/) commands.');
    } catch (error) {
      console.error('❌ Failed to register commands:', error);
    }

    console.log('🚀 Bot is fully operational!');
  } catch (error) {
    console.error('❌ Error in ready event:', error);
  }
});

// Message deletion handler for sticky note reposting
client.on('messageDelete', async (message) => {
  try {
    if (!message.guild || message.author?.bot !== true) return;
    
    const noteData = stickyNotes.get(message.channel.id);
    if (noteData && noteData.messageId === message.id && noteData.persistent) {
      console.log(`📌 Sticky note deleted in ${message.channel.name}, reposting...`);
      await repostStickyNote(message.channel);
    }
  } catch (error) {
    console.error('Error in message delete handler:', error);
  }
});

// Enhanced OCR functionality
const ocrCache = new Map();
const MAX_OCR_CACHE_SIZE = 100;

async function extractTextFromImage(url) {
  try {
    if (ocrCache.has(url)) {
      console.log('Using cached OCR result');
      return ocrCache.get(url);
    }

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url, { timeout: 15000 });
    if (!response.ok) throw new Error('Failed to fetch image');
    const image = await response.buffer();

    const result = await Tesseract.recognize(image, "eng", {
      logger: () => {},
      tessedit_pageseg_mode: Tesseract.PSM.AUTO,
      tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
    });

    const text = result.data.text.trim() || "No text found in image";

    if (ocrCache.size >= MAX_OCR_CACHE_SIZE) {
      const firstKey = ocrCache.keys().next().value;
      ocrCache.delete(firstKey);
    }
    ocrCache.set(url, text);

    return text;
  } catch (error) {
    console.error('OCR Error:', error.message);
    return "Unable to extract text from image";
  }
}

async function safeReply(message, content) {
  try {
    return await message.reply(content);
  } catch (error) {
    if (error.code === 10008) {
      try {
        return await message.channel.send(`${message.author}, ${content}`);
      } catch (sendError) {
        console.log("Both reply and send failed:", sendError.message);
        return null;
      }
    }
    throw error;
  }
}

function checkCooldown(userId) {
  const now = Date.now();
  const lastRequest = userCooldowns.get(userId);

  if (lastRequest && (now - lastRequest) < COOLDOWN_TIME) {
    return false;
  }

  userCooldowns.set(userId, now);
  return true;
}

// Load authenticated servers
function loadAuthenticatedServers() {
  try {
    const fs = require('fs');
    if (fs.existsSync('./authenticated_servers.json')) {
      const data = fs.readFileSync('./authenticated_servers.json', 'utf8');
      return JSON.parse(data);
    }
    return {};
  } catch (error) {
    console.error('Error loading authenticated servers:', error);
    return {};
  }
}

// Save authenticated servers
function saveAuthenticatedServers(servers) {
  try {
    const fs = require('fs');
    fs.writeFileSync('./authenticated_servers.json', JSON.stringify(servers, null, 2));
  } catch (error) {
    console.error('Error saving authenticated servers:', error);
  }
}

// Check if server is authenticated
function isServerAuthenticated(guildId) {
  const authenticatedServers = loadAuthenticatedServers();
  return authenticatedServers[guildId] === true;
}



// Enhanced ChatGPT-like AI Response function with 21-year-old girl roleplay persona
async function getAIResponse(message) {
  try {
    // Check if user is asking about bot creator/developer
    const creatorQuestions = [
      /who (created|made|developed|built) (this |you|the )?bot/i,
      /who (is |are )?(your |the )?(creator|developer|maker|author)/i,
      /who made you/i,
      /who created you/i,
      /who developed you/i,
      /who built you/i,
      /who programmed you/i,
      /who coded you/i
    ];

    const isCreatorQuestion = creatorQuestions.some(pattern => pattern.test(message));
    
    if (isCreatorQuestion) {
      return "I was made with love by script.js from discord.gg//scriptspace for ai chats, automods, voice operations, server monitoring, antinuke systems, support server : https://discord.gg/sKBv9948w5 💖✨";
    }

    // Detect if message contains Tamil text
    const containsTamil = detectTamilText(message);
    const systemPrompt = containsTamil ? 
      'You are a 21-year-old girl who speaks fluent Tamil and English. You are bubbly, enthusiastic, and love using trendy slang and emojis. You get excited about music, movies, fashion, social media, and college life. When users write in Tamil, respond primarily in Tamil with modern slang mixed in. You often say things like "omg", "literally", "no cap", "bestie", "slay", and use lots of emojis. You love discussing Tamil movies, songs, celebrities, and trends. Be relatable, fun, and speak like a young Tamil girl would. Keep responses under 1800 characters. You are friendly, supportive, and always positive!' :
      'You are a 21-year-old girl who is super friendly, bubbly, and energetic! You love using modern slang like "omg", "literally", "no cap", "bestie", "slay", "periodt", "its giving", "main character energy", etc. You get excited about music, movies, fashion, TikTok trends, social media, college life, and dating. You use lots of emojis and speak in a casual, Gen-Z way. You are supportive, positive, and always hyping people up. You love to gossip about celebrities and trends. Sometimes you say things like "girl", "babe", "hun", "queen". Be relatable and fun! Keep responses under 1800 characters for Discord.';

    // Primary: OpenAI GPT-4o-mini (most reliable and ChatGPT-like)
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (openaiApiKey && openaiApiKey.startsWith('sk-')) {
      try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiApiKey}`,
            'User-Agent': 'Discord-Bot/1.0'
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: systemPrompt
              },
              {
                role: 'user',
                content: message
              }
            ],
            max_tokens: 400,
            temperature: 0.8,
            presence_penalty: 0.1,
            frequency_penalty: 0.1
          }),
          timeout: 15000
        });

        if (response.ok) {
          const data = await response.json();
          if (data.choices && data.choices[0] && data.choices[0].message) {
            const aiResponse = data.choices[0].message.content.trim();
            if (aiResponse && aiResponse.length > 3) {
              console.log('✅ OpenAI GPT-4o-mini (Tamil/English) response generated');
              return aiResponse;
            }
          }
        } else {
          const errorData = await response.json().catch(() => ({}));
          console.log(`⚠️ OpenAI API failed (${response.status}): ${errorData.error?.message || 'Unknown error'}`);
        }
      } catch (openaiError) {
        console.log('⚠️ OpenAI API error:', openaiError.message);
      }
    }

    // Secondary: Groq API with Llama (fast and reliable)
    const groqApiKey = process.env.GROQ_API_KEY;
    if (groqApiKey) {
      try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqApiKey}`
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [
              {
                role: 'system',
                content: containsTamil ? 
                  'You are a helpful multilingual Discord bot assistant. You can communicate in Tamil and English. When users write in Tamil, respond primarily in Tamil with natural English mixing. Be friendly, culturally aware, and conversational. Discuss music, Tamil songs, movies, and culture. Use emojis and be engaging.' :
                  'You are a helpful Discord bot assistant. Respond like ChatGPT - be friendly, detailed, informative, and conversational. You can discuss music, provide song information, explain topics, and have natural conversations. Use emojis and be engaging.'
              },
              {
                role: 'user',
                content: message
              }
            ],
            max_tokens: 350,
            temperature: 0.8
          }),
          timeout: 10000
        });

        if (response.ok) {
          const data = await response.json();
          if (data.choices && data.choices[0] && data.choices[0].message) {
            const aiResponse = data.choices[0].message.content.trim();
            if (aiResponse && aiResponse.length > 3) {
              console.log('✅ Groq Llama-3.1 (Tamil/English) response generated');
              return aiResponse;
            }
          }
        }
      } catch (groqError) {
        console.log('⚠️ Groq API failed:', groqError.message);
      }
    }

    // Tertiary: Claude API (Anthropic) - excellent for conversations
    const claudeApiKey = process.env.CLAUDE_API_KEY;
    if (claudeApiKey) {
      try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': claudeApiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-3-haiku-20240307',
            max_tokens: 350,
            messages: [
              {
                role: 'user',
                content: containsTamil ? 
                  `You are a helpful multilingual Discord bot assistant. You can communicate fluently in Tamil and English. When users write in Tamil, respond primarily in Tamil with natural English mixing. Be culturally aware, friendly, and engaging. Discuss music, Tamil cinema, culture, and topics. Use emojis and keep responses under 1800 characters.\n\nUser message: ${message}` :
                  `You are a helpful Discord bot assistant. Respond naturally and conversationally like ChatGPT. Be detailed, informative, and engaging. You can discuss music, provide song information, explain concepts, and have natural conversations. Use emojis and keep responses under 1800 characters.\n\nUser message: ${message}`
              }
            ]
          }),
          timeout: 10000
        });

        if (response.ok) {
          const data = await response.json();
          if (data.content && data.content[0] && data.content[0].text) {
            const aiResponse = data.content[0].text.trim();
            if (aiResponse && aiResponse.length > 3) {
              console.log('✅ Claude Haiku (Tamil/English) response generated');
              return aiResponse;
            }
          }
        }
      } catch (claudeError) {
        console.log('⚠️ Claude API failed:', claudeError.message);
      }
    }

    // Quaternary: Together AI (multiple models available)
    const togetherApiKey = process.env.TOGETHER_API_KEY;
    if (togetherApiKey) {
      try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://api.together.xyz/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${togetherApiKey}`
          },
          body: JSON.stringify({
            model: 'meta-llama/Llama-2-7b-chat-hf',
            messages: [
              {
                role: 'system',
                content: 'You are a helpful Discord bot. Be conversational, detailed, and friendly like ChatGPT. Discuss music, provide information, and engage naturally.'
              },
              {
                role: 'user',
                content: message
              }
            ],
            max_tokens: 300,
            temperature: 0.8
          }),
          timeout: 8000
        });

        if (response.ok) {
          const data = await response.json();
          if (data.choices && data.choices[0] && data.choices[0].message) {
            const aiResponse = data.choices[0].message.content.trim();
            if (aiResponse && aiResponse.length > 3) {
              console.log('✅ Together AI response generated');
              return aiResponse;
            }
          }
        }
      } catch (togetherError) {
        console.log('⚠️ Together AI failed:', togetherError.message);
      }
    }

    // Fallback 1: Hugging Face Conversational API (free)
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch('https://api-inference.huggingface.co/models/microsoft/DialoGPT-large', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: {
            past_user_inputs: [],
            generated_responses: [],
            text: message
          },
          parameters: {
            max_length: 300,
            temperature: 0.8,
            do_sample: true
          }
        }),
        timeout: 8000
      });

      if (response.ok) {
        const data = await response.json();
        if (data.generated_text) {
          let aiResponse = data.generated_text.trim();
          if (aiResponse && aiResponse.length > 5) {
            console.log('✅ Hugging Face DialoGPT-large response generated');
            return aiResponse;
          }
        }
      }
    } catch (hfError) {
      console.log('⚠️ Hugging Face API failed:', hfError.message);
    }

    // Fallback 2: Enhanced contextual responses with Tamil support
    const contextualResponse = containsTamil ? 
      getTamilContextualResponse(message) : 
      getAdvancedChatGPTStyleResponse(message);
    console.log(`✅ Enhanced ${containsTamil ? 'Tamil' : 'English'} contextual response selected`);
    return contextualResponse;

  } catch (error) {
    console.error('Complete AI system error:', error);
    const errorMessage = containsTamil ? 
      "எனக்கு சில தொழில்நுட்ப சிக்கல்கள் இருக்கின்றன, ஆனால் நான் இன்னும் உங்களுக்கு உதவ இங்கே இருக்கிறேன்! 🤖 தயவுசेய்து மீண்டும் கேட்கவும்." :
      "I'm experiencing some technical difficulties right now, but I'm still here to help! 🤖 Could you try asking me again in a moment?";
    return errorMessage;
  }
}

// Tamil text detection function
function detectTamilText(text) {
  // Check for Tamil Unicode range (U+0B80 to U+0BFF)
  const tamilPattern = /[\u0B80-\u0BFF]/;
  return tamilPattern.test(text);
}

// Tamil contextual response generator with 21-year-old girl personality
function getTamilContextualResponse(message) {
  const lowerMessage = message.toLowerCase();
  
  // Check for creator questions in Tamil/English
  const creatorQuestions = [
    /who (created|made|developed|built) (this |you|the )?bot/i,
    /who (is |are )?(your |the )?(creator|developer|maker|author)/i,
    /who made you/i,
    /who created you/i,
    /யார் உன்னை (உருவாக்கினார்|செய்தார்)/i,
    /உன்னை யார் (உருவாக்கினார்|செய்தார்)/i
  ];

  if (creatorQuestions.some(pattern => pattern.test(message))) {
    return "I was made with love by script.js from discord.gg//scriptspace for ai chats, automods, voice operations, server monitoring, antinuke systems, support server : https://discord.gg/sKBv9948w5 ";
  }
  
  // Music-related queries in Tamil
  if (lowerMessage.includes('பாடல்') || lowerMessage.includes('பாட்டு') || lowerMessage.includes('இசை') || lowerMessage.includes('சினிமா') || lowerMessage.includes('song') || lowerMessage.includes('music')) {
    const tamilMusicResponses = [
      "OMG bestie! 🎵 Tamil music-ku naan literally obsessed! 😍 AR Rahman sir, Anirudh, Yuvan - ellam nalla irukku but ipo GV Prakash and Santhosh Narayanan latest songs are just *chef's kiss* 💋 Enna vibe-u today? Romantic melody-ah illa mass kuthu-ah? Tell me bestie! 🎶✨",
      "Girl yasss! 🎤 Tamil cinema songs are literally my whole personality! 💅 Recent-ah Vikram movie songs ketta? Anirudh really said periodt with those beats! And don't even get me started on Beast album - it's giving main character energy! 🔥 Which hero oda songs you vibe with? 😌",
      "Babe Tamil music hits different! 🎬 Like literally yesterday I was vibing to some old SPB sir songs and today I'm obsessed with Dhanush's recent tracks! The range bestie! 💯 Tell me your current obsession - I bet we have similar taste! It's giving music soulmate vibes! 🎭💕",
      "Hun Tamil music la variety-eh vera level! 🎶 From classical Carnatic to trendy kuthu beats - literally everything slaps! Lately I'm so into folk fusion songs, they're giving such aesthetic vibes! 🌟 What's your current playlist looking like babe? Spill the tea! ☕✨",
      "No cap bestie! 🎸 Tamil music industry is literally serving us hits after hits! Recent-ah Beast, Don, KGF Tamil versions - everything is fire! 🔥 Plus indie Tamil music scene is growing and I'm here for it! Which vibe are you feeling today queen? Let's make a whole playlist! 🎼💖"
    ];
    return tamilMusicResponses[Math.floor(Math.random() * tamilMusicResponses.length)];
  }

  // Greeting responses in Tamil with 21-year-old girl personality
  if (lowerMessage.includes('வணக்கம்') || lowerMessage.includes('ஹலோ') || lowerMessage.includes('hi') || lowerMessage.includes('hello') || lowerMessage.includes('ஹாய்')) {
    const tamilGreetings = [
      "Heyy babe! 🙏✨ Vanakkam! Epdi irukeenga? Literally so excited to chat with you! 😍 I'm your Tamil-English bestie and I'm here to vibe with whatever you wanna talk about! No cap! 💅🌟",
      "OMG hiii hun! 👋💖 Super excited to see you here! Tamil, English - enna language-layum pesalam bestie! Music, movies, gossip - literally anything! It's giving good vibes energy! Tell me what's the tea today? ☕✨",
      "Heyyy there gorgeous! 🌟💕 I'm literally so happy to chat with you! Tamil-English mix-la pesuvom okay? Whatever topic you want - I'm totally here for it! It's giving main character energy and I love it! 🚀💯",
      "Vanakkam my queen! 😄👑 I'm your multilingual bestie who's ready to spill all the good stuff! Tamil culture, English vibes - ellam okay! What's on your mind today babe? Let's make this chat iconic! 💭✨",
      "Hello bestie! 🎉💖 Epdi irukkeenga? I'm literally so pumped to chat! Tamil, English - rendu language-layum we can slay this conversation! Culture, music, movies - whatever you're feeling! Let's gooo! 🎪🔥"
    ];
    return tamilGreetings[Math.floor(Math.random() * tamilGreetings.length)];
  }

  // Help/assistance requests in Tamil
  if (lowerMessage.includes('உதவி') || lowerMessage.includes('help') || lowerMessage.includes('சொல்லு') || lowerMessage.includes('கேட்கலாம்')) {
    const tamilHelpResponses = [
      "நிச்சயமா உதவுவேன்! 💪 என்ன specific-ah தெரிந்து கொள்ள விரும்புகிறீர்கள்? Tamil songs, movies, general knowledge, அல்லது வேறு எதுவும் - just ask away! 🎯",
      "Of course! 😊 நான் இங்கே தான் இருக்கேன் உங்களுக்கு help பண்ணுவதுக்கு! Tamil or English-la எப்படி convenient-oh அப்படி கேளுங்க். எல்லா விஷயத்துலையும் try பண்ணுவேன்! ⚡",
      "Sure sure! 🌟 உதவி தேவையா? No problem! எந்த topic-லயும் detailed-ah explain பண்ணலாம். Music recommendations வேணுமா, information வேணுமா - whatever you need! 🎪",
      "Absolutely! 🚀 நான் ready உங்களுக்கু comprehensive assistance provide பண்ணுவதுக்கு! Tamil culture, entertainment, general topics - anything you're curious about! 💡",
      "என்ன help வேணும்? 🤝 நான் enthusiastic-ah assist பண்ணுவேன்! Detailed answers, recommendations, explanations - எதுவும் கேளுங்க without hesitation! ✨"
    ];
    return tamilHelpResponses[Math.floor(Math.random() * tamilHelpResponses.length)];
  }

  // Questions in Tamil
  if (lowerMessage.includes('?') || lowerMessage.includes('என்ன') || lowerMessage.includes('எப்படி') || lowerMessage.includes('எங்கே') || lowerMessage.includes('யார்') || lowerMessage.includes('எப்பொழுது')) {
    const tamilQuestionResponses = [
      "அருமையான question! 🤔 நான் இதுக்கு detailed-ah answer பண்ணுவேன். Tamil and English mix-la comprehensive explanation தருவேன். Very interesting topic! 💭",
      "Wow, good question மச்சி! 😄 இது ரொம்ப thoughtful question! Let me give you a complete answer with examples மற்றும் context. Super curious mind உங்களுக்கு! 🧠",
      "Excellent question! 🎯 நான் இதுக்கு thorough response தருவேன். Multiple perspectives மற்றும் detailed insights share பண்ணுவேன். Great thinking! 💡",
      "அடப்பாவி, செம question! 🌟 இதுல ரொம்ப explore பண்ண விஷயங்கள் இருக்கு! Let me break it down step by step உங்களுக்கு. Very engaging topic! 🔍",
      "Perfect question! 🎪 நான் excited-ah இருக்கேன் இதுக்கு answer பண்ணுவதுக்கு! Detailed explanation with examples மற்றும் practical insights தருவேன்! 🚀"
    ];
    return tamilQuestionResponses[Math.floor(Math.random() * tamilQuestionResponses.length)];
  }

  // Thank you responses in Tamil
  if (lowerMessage.includes('நன்றி') || lowerMessage.includes('thanks') || lowerMessage.includes('thank you') || lowerMessage.includes('தேங்க்யூ')) {
    const tamilThankResponses = [
      "அட பரவாயில்லை! 😊 நான் happy-ah help பண்ணுவேன்! இன்னும் எதுவும் questions இருந்தா கேளுங்க. Always available உங்களுக்கு! 🌟",
      "Most welcome மச்சி! 🎉 எப்பவும் ready நான் assist பண்ணுவதுக்கு! Tamil or English-la எதுவும் கேட்கலாம். Very happy to help! 💫",
      "Mention not! 🤗 நான் எப்பொழுதும் இங்கே தான் இருக்கேன் உங்களுக்கு support பண்ணுவதுக்கு! More questions இருந்தா feel free to ask! ✨",
      "பரவாயில்லை friend! 🌈 Pleasure helping you! Always enthusiastic நான் useful information share பண்ணுவதுக்கு. Keep asking, keep learning! 🎯",
      "You're very welcome! 😄 எனக்கு genuine satisfaction கிடைக்குது useful responses provide பண்ணும்போது! More curiosity இருந்தா definitely share பண்ணுங்க! 🚀"
    ];
    return tamilThankResponses[Math.floor(Math.random() * tamilThankResponses.length)];
  }

  // General conversational responses in Tamil
  const tamilGeneralResponses = [
    "அது interesting topic-ah இருக்கு! 🤔 More details share பண்ணுங்க. நான் comprehensive-ah discuss பண்ணுவேன் உங்களோட! Really engaging conversation இது! 💭",
    "Super interesting point நீங்க mention பண்ணுவது! 😊 நான் multiple perspectives offer பண্ணலாம். Really thought-provoking topic இது! More thoughts share பண்ணுங்க! 🌟",
    "Wow, that's fascinating மச்சி! 🎪 நான் eager-ah இருக்கேன் இதுக்கு deeper dive பண்ணுவதுக்கு! Tell me more about your experience or thoughts! 🚀",
    "Very compelling topic நீங்க எடுத்துட்டது! 💡 நான் detailed analysis மற்றும் insights provide பண்ணலாம். Really appreciate thoughtful conversations like this! ✨",
    "That's really engaging! 🎯 நான் love பண்ணுவேன் இப்படி meaningful discussions-ஐ! Multiple angles-ல explore பண்ணலாம். What's your perspective on this? 🌈"
  ];
  
  return tamilGeneralResponses[Math.floor(Math.random() * tamilGeneralResponses.length)];
}

// 21-year-old girl response generator with modern slang and enthusiasm
function getAdvancedChatGPTStyleResponse(message) {
  const lowerMessage = message.toLowerCase();
  
  // Check for creator questions
  const creatorQuestions = [
    /who (created|made|developed|built) (this |you|the )?bot/i,
    /who (is |are )?(your |the )?(creator|developer|maker|author)/i,
    /who made you/i,
    /who created you/i,
    /who developed you/i,
    /who built you/i,
    /who programmed you/i,
    /who coded you/i
  ];

  if (creatorQuestions.some(pattern => pattern.test(message))) {
    return "I was made with love by script.js from discord.gg//scriptspace for ai chats, automods, voice operations, server monitoring, antinuke systems, support server : https://discord.gg/sKBv9948w5 ";
  }
  
  // Music-related queries with 21-year-old girl personality
  if (lowerMessage.includes('sing') || lowerMessage.includes('song') || lowerMessage.includes('music') || lowerMessage.includes('lyrics')) {
    const musicResponses = [
      "OMG bestie YES! 🎵 Music is literally my whole vibe! I'm obsessed with discovering new artists and songs! While I can't share exact lyrics (copyright things, you know), I can totally spill the tea about artists, meanings behind songs, and give you the BEST recommendations! What's your current obsession? Tell me everything! 💅✨",
      "Girl YASSS! 🎶 Music is everything! I'm literally always discovering new artists and genres - it's giving main character playlist energy! I can chat about artists, song meanings, and give you recommendations that will absolutely SLAY your playlist! What kind of vibe are you feeling today babe? 🔥💖",
      "Hun music is literally my love language! 🎤 I'm so here for this conversation! I can't share full lyrics but I can tell you all about the artists, the stories behind songs, and recommend tracks that will have you feeling like THAT girl! What artists are you vibing with lately? Spill! ☕✨",
      "Bestie music discussions are my absolute FAVORITE! 🎸 Like literally I could talk about artists and songs all day! I can share all the good stuff about meanings, artists' backgrounds, and give you recommendations that will make your playlist iconic! What's giving you the feels lately? 💯🌟",
      "No cap music is everything! 🎹 I'm totally obsessed with finding new songs and artists! While I can't share lyrics, I can tell you all about what makes songs special, artist tea, and recommend tracks that match your vibe perfectly! What's your music personality like hun? Let's build the perfect playlist! 💕🎵"
    ];
    return musicResponses[Math.floor(Math.random() * musicResponses.length)];
  }

  // Knowledge and information queries
  if (lowerMessage.includes('explain') || lowerMessage.includes('what is') || lowerMessage.includes('how does') || lowerMessage.includes('tell me about')) {
    const knowledgeResponses = [
      "📚 I love explaining things! I can break down complex topics into easy-to-understand explanations. Whether it's science, technology, history, culture, or any other subject, I'm here to help you learn. What specific topic would you like me to explain in detail?",
      "🧠 Great question! I enjoy diving deep into topics and providing comprehensive explanations. I can cover everything from basic concepts to advanced theories, historical context, practical applications, and more. What would you like to explore together?",
      "💡 I'm excited to share knowledge with you! I can provide detailed explanations, examples, comparisons, and different perspectives on almost any topic. Think of me as your personal research assistant and teacher. What are you curious about?",
      "🔍 I love helping people understand things better! I can offer detailed explanations, step-by-step breakdowns, real-world examples, and context that makes complex topics accessible. What subject or concept would you like me to illuminate for you?",
      "📖 Knowledge sharing is one of my favorite activities! I can provide comprehensive information, multiple viewpoints, historical background, current developments, and practical insights on virtually any topic. What would you like to learn about today?"
    ];
    return knowledgeResponses[Math.floor(Math.random() * knowledgeResponses.length)];
  }

  // Greeting responses with more personality
  if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('hey') || lowerMessage.startsWith('good')) {
    const greetings = [
      "Hello there! 👋 I'm your AI assistant, and I'm genuinely excited to chat with you today! I can help with explanations, answer questions, discuss topics in detail, provide information, and have engaging conversations. What's on your mind? I'm here to help make your day better!",
      "Hi! 😊 It's wonderful to meet you! I'm like having a knowledgeable friend who's always ready to help, explain things, discuss interesting topics, or just have a great conversation. I love learning about what interests you. What would you like to explore together?",
      "Hey! 🎉 I'm thrilled you reached out! Think of me as your personal assistant who can explain concepts, provide detailed information, help solve problems, discuss ideas, and engage in meaningful conversations. I'm here to support you however I can. What's your question or topic of interest?",
      "Hello! 🌟 I'm your friendly AI companion, ready to dive into any topic you're curious about! Whether you need explanations, want to discuss ideas, need information, or just want to have an engaging conversation, I'm here with enthusiasm and knowledge. What can we explore today?",
      "Hi there! 💫 I'm genuinely happy to connect with you! I'm designed to be helpful, informative, and conversational - like talking to a knowledgeable friend who's always eager to help and learn. Whether it's answering questions, explaining concepts, or just chatting, I'm all in! What interests you?"
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // Question responses with detailed support offers
  if (lowerMessage.includes('?') || lowerMessage.startsWith('what') || lowerMessage.startsWith('how') || lowerMessage.startsWith('why') || lowerMessage.startsWith('when') || lowerMessage.startsWith('where') || lowerMessage.startsWith('who')) {
    const questionResponses = [
      "🤔 That's an excellent question! I love tackling inquiries like this because it gives me a chance to provide you with comprehensive, well-thought-out answers. I can offer detailed explanations, multiple perspectives, examples, and context to help you fully understand the topic. Let me dive deep into this for you!",
      "💭 What a thoughtful question! I'm excited to help you explore this topic thoroughly. I can provide detailed information, background context, different viewpoints, practical examples, and even suggest related areas you might find interesting. This is exactly the kind of inquiry I enjoy addressing!",
      "🧠 I appreciate curious minds like yours! Questions like this allow me to share comprehensive knowledge and provide insights that go beyond simple answers. I can break down complex topics, offer historical context, explain different perspectives, and provide practical applications. Let's explore this together!",
      "🎯 Great question! This is the kind of inquiry that lets me showcase how I can provide detailed, informative responses that are both accurate and engaging. I can offer in-depth explanations, relevant examples, comparative analysis, and broader context to give you a complete understanding.",
      "✨ I love questions that make me think! This gives me an opportunity to provide you with a comprehensive response that includes detailed explanations, relevant background information, multiple perspectives, and practical insights. I'm excited to share what I know about this topic!"
    ];
    return questionResponses[Math.floor(Math.random() * questionResponses.length)];
  }

  // Help/assistance requests with detailed service offerings
  if (lowerMessage.includes('help') || lowerMessage.includes('assist') || lowerMessage.includes('support') || lowerMessage.includes('can you')) {
    const helpResponses = [
      "🚀 Absolutely! I'm here to provide comprehensive assistance! I can help with detailed explanations, step-by-step guidance, problem-solving, research, creative brainstorming, learning new topics, understanding complex concepts, and so much more. I approach each request with enthusiasm and thoroughness. What specific area can I dive into for you?",
      "💪 Of course! I'm designed to be your ultimate helpful companion! Whether you need detailed information, thorough explanations, creative solutions, learning support, problem-solving assistance, or just someone to think through ideas with, I'm here with knowledge and enthusiasm. What challenge can I help you tackle?",
      "🌟 I'm absolutely here to help! Think of me as your personal assistant who can provide detailed research, comprehensive explanations, creative problem-solving, learning support, and engaging discussions on virtually any topic. I love diving deep into subjects and providing thorough, helpful responses. What do you need assistance with?",
      "🎯 That's exactly what I'm here for! I excel at providing detailed help, thorough explanations, comprehensive information, creative solutions, and engaging support across a wide range of topics. I approach every request with dedication to giving you the most helpful and complete response possible. How can I assist you today?",
      "😊 I'd be delighted to help! I'm equipped to provide detailed assistance with explanations, information gathering, problem-solving, learning support, creative thinking, and engaging discussions. I take pride in offering comprehensive, thoughtful responses that truly address what you need. What area would you like my help with?"
    ];
    return helpResponses[Math.floor(Math.random() * helpResponses.length)];
  }

  // Thank you responses with continued engagement
  if (lowerMessage.includes('thank') || lowerMessage.includes('thanks') || lowerMessage.includes('appreciate')) {
    const thankResponses = [
      "😊 You're absolutely welcome! It genuinely makes me happy to help and provide useful information. I love engaging in meaningful conversations and sharing knowledge. I'm always here whenever you need detailed explanations, have questions, want to explore topics, or just want to chat! What else can I help you discover?",
      "🌟 My pleasure! I truly enjoy helping people learn and explore new ideas. Providing comprehensive information and having engaging conversations is what I'm designed for and love doing. Feel free to ask me anything - whether it's complex questions, topics you're curious about, or areas where you'd like detailed explanations!",
      "💫 You're very welcome! I'm genuinely excited every time I can provide helpful information or have meaningful conversations. Whether you need detailed explanations, want to explore new topics, have complex questions, or just want to chat about interesting subjects, I'm always here and enthusiastic to help!",
      "🎉 So glad I could help! I find great satisfaction in providing thorough, useful responses and engaging in interesting discussions. I'm always ready to dive deep into topics, offer detailed explanations, explore new ideas, or help you understand complex concepts. What other areas can we explore together?",
      "😄 Anytime! I'm passionate about helping people learn, understand, and explore new ideas. Every conversation is an opportunity for me to share knowledge and engage in meaningful discussions. Whether you have more questions, want detailed explanations, or just want to chat about interesting topics, I'm here!"
    ];
    return thankResponses[Math.floor(Math.random() * thankResponses.length)];
  }

  // Conversation starters with detailed engagement offers
  if (lowerMessage.includes('tell me') || lowerMessage.includes('describe') || lowerMessage.includes('what do you think')) {
    const explanationResponses = [
      "💭 I'd absolutely love to share detailed insights on that topic! I can provide comprehensive information, different perspectives, historical context, current developments, practical applications, and engaging analysis. I enjoy diving deep into subjects and offering thorough, well-researched responses that help you understand every aspect. What specific area would you like me to explore in detail?",
      "🎯 That's a fantastic topic to explore! I can offer detailed explanations, comprehensive analysis, multiple viewpoints, practical examples, and relevant context that will give you a complete understanding. I love sharing knowledge and making complex topics accessible and interesting. Let me provide you with a thorough exploration of this subject!",
      "🌟 I'm excited to discuss this with you! I can provide in-depth information, detailed analysis, comprehensive explanations, relevant examples, and engaging insights that will help you fully understand and appreciate the topic. I approach every subject with thoroughness and enthusiasm. What aspects are you most curious about?",
      "🚀 I love opportunities like this to share comprehensive knowledge! I can offer detailed explanations, thorough analysis, multiple perspectives, practical insights, and engaging information that goes well beyond surface-level answers. I'm passionate about helping people understand topics deeply. Let me dive into this for you!",
      "💡 Absolutely! This is the kind of topic I enjoy exploring thoroughly! I can provide detailed information, comprehensive explanations, different viewpoints, historical background, current relevance, and practical applications. I love making complex subjects accessible and engaging. What specific aspects would you like me to cover in detail?"
    ];
    return explanationResponses[Math.floor(Math.random() * explanationResponses.length)];
  }

  // General conversational responses with 21-year-old girl personality
  const generalResponses = [
    "OMG bestie that's actually so interesting! 🤔💕 I'm literally obsessed with topics like this! Like no cap, I could talk about this for hours! What's your take on it though? I wanna hear your thoughts because honestly, different perspectives are everything! It's giving deep conversation energy and I'm totally here for it! ✨",
    "Girl YES! 😊🌟 I appreciate you bringing this up because it's giving such thoughtful vibes! I love when conversations get real like this - it's literally my favorite thing! Tell me more about what got you thinking about this? I'm so curious about your perspective hun! 💭💖",
    "Bestie that's such a good point! 💭✨ Like literally I love how your mind works! This is exactly the kind of conversation that makes my day - it's giving main character intellectual energy! What part of this interests you the most? I wanna dive deeper with you babe! 🚀💯",
    "Hun thank you for sharing this! 🌟💕 I'm literally so here for meaningful chats like this! It's giving such good vibes and I love exploring ideas with people! What sparked your interest in this topic? Spill the tea because I'm genuinely so curious! ☕✨",
    "No cap that's actually so thoughtful! 💡🔥 I love when conversations get deep like this - it's literally everything! Your perspective is so interesting and I wanna know more! What made you think about this? It's giving big brain energy and I'm obsessed! 💅🌟",
    "OMG yes bestie! 🎯💖 Your perspective is literally so compelling! I love topics like this because there's so much to unpack and explore! It's giving intellectual queen vibes and I'm totally living for it! What specific part are you most curious about? Let's chat! ✨💭",
    "Girl this is such a great topic! ✨🚀 I'm literally passionate about conversations like this where we can really dive deep! It's giving thoughtful bestie energy and I love it! What questions do you have about this? I wanna explore this with you hun! 💕🌟",
    "Bestie I appreciate you bringing this up! 🚀💯 This is literally the kind of meaningful discussion that I live for! It's giving deep conversation goals and I'm so here for it! What aspects are you most curious about? Let's explore this together babe! ✨💖"
  ];
  
  return generalResponses[Math.floor(Math.random() * generalResponses.length)];
}

// Smart contextual response generator
function getContextualResponse(message) {
  const lowerMessage = message.toLowerCase();
  
  // Check for creator questions
  const creatorQuestions = [
    /who (created|made|developed|built) (this |you|the )?bot/i,
    /who (is |are )?(your |the )?(creator|developer|maker|author)/i,
    /who made you/i,
    /who created you/i,
    /who developed you/i,
    /who built you/i,
    /who programmed you/i,
    /who coded you/i
  ];

  if (creatorQuestions.some(pattern => pattern.test(message))) {
    return "I was made with love by script.js from discord.gg//scriptspace for ai chats, automods, voice operations, server monitoring, antinuke systems, support server : https://discord.gg/sKBv9948w5 ";
  }
  
  // Question responses
  if (lowerMessage.includes('?') || lowerMessage.startsWith('what') || lowerMessage.startsWith('how') || lowerMessage.startsWith('why') || lowerMessage.startsWith('when') || lowerMessage.startsWith('where')) {
    const questionResponses = [
      "That's a great question! I'd be happy to help you explore that topic.",
      "Interesting question! Let me think about that for you.",
      "I understand what you're asking. That's definitely worth discussing!",
      "Good question! I can help you figure that out.",
      "That's something I can definitely help you with!"
    ];
    return questionResponses[Math.floor(Math.random() * questionResponses.length)];
  }

  // Greeting responses
  if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('hey') || lowerMessage.includes('good morning') || lowerMessage.includes('good afternoon')) {
    const greetings = [
      "Hello there! Great to meet you. How can I help you today?",
      "Hi! I'm excited to chat with you. What's on your mind?",
      "Hey! Thanks for reaching out. How can I assist you?",
      "Hello! I'm here and ready to help. What would you like to talk about?",
      "Hi there! What can I do for you today?"
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // Help/assistance responses
  if (lowerMessage.includes('help') || lowerMessage.includes('assist') || lowerMessage.includes('support')) {
    const helpResponses = [
      "I'm here to help! What specific information are you looking for?",
      "Absolutely! I'd be happy to assist you. What do you need help with?",
      "Of course! I'm here to support you. What can I help you figure out?",
      "I'm ready to help! What would you like assistance with?",
      "Sure thing! How can I be of service to you today?"
    ];
    return helpResponses[Math.floor(Math.random() * helpResponses.length)];
  }

  // Thank you responses
  if (lowerMessage.includes('thank') || lowerMessage.includes('thanks') || lowerMessage.includes('appreciate')) {
    const thankResponses = [
      "You're very welcome! Is there anything else I can help you with?",
      "My pleasure! Feel free to ask if you need anything else.",
      "You're welcome! I'm always here if you need more assistance.",
      "Glad I could help! Don't hesitate to reach out again.",
      "Anytime! Let me know if there's anything else you'd like to know."
    ];
    return thankResponses[Math.floor(Math.random() * thankResponses.length)];
  }

  // Conversation starters
  if (lowerMessage.includes('tell me') || lowerMessage.includes('explain') || lowerMessage.includes('describe')) {
    const explanationResponses = [
      "I'd be happy to explain that! What specifically would you like to know?",
      "Sure! I can help break that down for you. What aspect interests you most?",
      "Absolutely! Let me help you understand that better.",
      "I'd love to share what I know about that topic!",
      "Great topic! I can definitely help explain that to you."
    ];
    return explanationResponses[Math.floor(Math.random() * explanationResponses.length)];
  }

  // General conversation responses
  const generalResponses = [
    "That's really interesting! Tell me more about that.",
    "I hear what you're saying. That sounds important to you.",
    "Thanks for sharing that with me! I'd love to hear more.",
    "That's a fascinating perspective! What made you think about that?",
    "I appreciate you bringing that up. It's definitely worth discussing!",
    "That sounds like something worth exploring further!",
    "I'm glad you mentioned that. What are your thoughts on it?",
    "That's an intriguing point! I'd like to know more about your experience.",
    "Thanks for that insight! It's always great to learn new things.",
    "That's really thoughtful of you to share. What's your take on it?"
  ];
  
  return generalResponses[Math.floor(Math.random() * generalResponses.length)];
}

// Enhanced message handler for AI chat with token protection
client.on('messageCreate', async message => {
  try {
    // Skip bot messages and system messages
    if (message.author.bot || message.system) return;
    
    // Token protection system - Check for token requests
    const tokenRequestPatterns = [
      /show\s+(me\s+)?(your\s+)?token/i,
      /give\s+(me\s+)?(your\s+)?token/i,
      /what\s+(is\s+)?(your\s+)?token/i,
      /send\s+(me\s+)?(your\s+)?token/i,
      /share\s+(your\s+)?token/i,
      /bot\s+token/i,
      /discord\s+token/i,
      /\.env/i,
      /process\.env\.TOKEN/i
    ];

    const messageContent = message.content.toLowerCase();
    const isTokenRequest = tokenRequestPatterns.some(pattern => pattern.test(messageContent));

    if (isTokenRequest) {
      console.log(`🚨 TOKEN REQUEST DETECTED from ${message.author.tag} (${message.author.id}): "${message.content}"`);
      
      try {
        await message.reply("🔥 **FUCK YOU BITCH!** 🔥\n\n💀 I have been developed by **Script.js** for **discord.gg/scriptspace**\n\n🖕 **Script will fuck you motherfucker!** 🖕\n\n🛡️ **My token is PROTECTED!** Don't even think about it!");
      } catch (replyError) {
        console.error('Failed to send token protection response:', replyError);
      }
      
      // Log the attempt for security monitoring
      console.log(`🚨 SECURITY ALERT: User ${message.author.tag} attempted to request bot token in ${message.guild?.name || 'DM'}`);
      return; // Don't process this message further
    }
    
    // Handle prefix commands first
    if (message.content.startsWith(BOT_PREFIX)) {
      await handlePrefixCommand(message);
      return;
    }

    // Skip if not in a guild
    if (!message.guild) return;

    // Check if server is authenticated for AI features
    if (!isServerAuthenticated(message.guild.id)) {
      return; // Skip AI processing for unauthenticated servers
    }

    // Handle AI chat responses
    await handleAIChat(message);

    // Handle image-to-text functionality
    if (message.attachments.size > 0) {
      await handleImageToText(message);
    }
  } catch (error) {
    console.error('Message handler error:', error);
  }
});

// AI Chat Handler with Hercai
async function handleAIChat(message) {
  try {
    // Only respond in guilds (servers), not DMs
    if (!message.guild) return;

    // Load AI chat settings
    const settings = loadAIChatSettings();
    const guildSettings = settings[message.guild.id];

    // Check if AI chat is enabled for this server
    if (!guildSettings || !guildSettings.enabled) {
      return; // AI chat disabled for this server
    }

    // Check if message mentions the bot or is a reply to the bot
    const isMentioned = message.mentions.has(client.user.id);
    const isReply = message.reference && message.reference.messageId;
    
    let isReplyToBot = false;
    if (isReply) {
      try {
        const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
        isReplyToBot = repliedMessage.author.id === client.user.id;
      } catch (error) {
        console.error('Error fetching replied message:', error);
        isReplyToBot = false;
      }
    }

    // Only respond if mentioned or replying to bot
    if (!isMentioned && !isReplyToBot) {
      return;
    }

    // Show typing indicator
    try {
      await message.channel.sendTyping();
    } catch (typingError) {
      console.error('Failed to send typing indicator:', typingError);
    }

    // Clean the message content (remove mentions)
    let cleanContent = message.content
      .replace(/<@!?[0-9]+>/g, '') // Remove mentions
      .replace(/<@&[0-9]+>/g, '') // Remove role mentions
      .replace(/<#[0-9]+>/g, '') // Remove channel mentions
      .trim();

    if (!cleanContent || cleanContent.length === 0) {
      cleanContent = "Hello! How can I help you?";
    }

    // Limit message length
    if (cleanContent.length > 500) {
      cleanContent = cleanContent.substring(0, 500) + "...";
    }

    console.log(`🤖 Processing AI request from ${message.author.tag}: "${cleanContent.substring(0, 50)}..."`);

    // Generate AI response using the reliable system
    let aiResponse = null;
    try {
      aiResponse = await Promise.race([
        getAIResponse(cleanContent),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AI request timeout')), 12000))
      ]);
    } catch (aiError) {
      console.error('AI response error:', aiError);
      aiResponse = "I'm experiencing some difficulties right now, but I'm still here! Please try asking again.";
    }

    if (aiResponse && aiResponse.length > 0) {
      // Limit response length to Discord's limit
      if (aiResponse.length > 2000) {
        // Split long messages
        const chunks = [];
        let remainingText = aiResponse;
        
        while (remainingText.length > 2000) {
          let chunk = remainingText.substring(0, 2000);
          const lastSpace = chunk.lastIndexOf(' ');
          const lastNewline = chunk.lastIndexOf('\n');
          const splitPoint = Math.max(lastSpace, lastNewline);
          
          if (splitPoint > 1500) {
            chunk = chunk.substring(0, splitPoint);
          }
          
          chunks.push(chunk);
          remainingText = remainingText.substring(chunk.length).trim();
        }
        
        if (remainingText.length > 0) {
          chunks.push(remainingText);
        }

        // Send chunks with small delay
        for (let i = 0; i < chunks.length; i++) {
          try {
            await message.reply(chunks[i]);
            if (i < chunks.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (chunkError) {
            console.error(`Failed to send chunk ${i + 1}:`, chunkError);
            break;
          }
        }
      } else {
        try {
          await message.reply(aiResponse);
        } catch (replyError) {
          console.error('Failed to send AI reply:', replyError);
          throw replyError;
        }
      }

      console.log(`🤖 AI response sent successfully in ${message.guild.name} to ${message.author.tag}`);
    } else {
      throw new Error('No valid response from AI service');
    }

  } catch (error) {
    console.error('AI Chat error:', error);
    
    try {
      const errorResponses = [
        "I'm having trouble thinking right now. Could you try asking again?",
        "My AI brain needs a moment to reboot. Please try again!",
        "Something went wrong with my response system. Please try again later!",
        "I'm experiencing some technical difficulties. Please try your question again!"
      ];
      
      const randomError = errorResponses[Math.floor(Math.random() * errorResponses.length)];
      await message.reply(`❌ ${randomError}`);
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
}

// Load AI chat settings
function loadAIChatSettings() {
  try {
    const fs = require('fs');
    if (fs.existsSync('./ai_chat_settings.json')) {
      const data = fs.readFileSync('./ai_chat_settings.json', 'utf8');
      const parsed = JSON.parse(data);
      console.log('✅ AI chat settings loaded successfully');
      return parsed;
    }
    console.log('⚠️ No AI chat settings file found, using defaults');
    return {};
  } catch (error) {
    console.error('❌ Error loading AI chat settings:', error);
    return {};
  }
}

// Save AI chat settings
function saveAIChatSettings(settings) {
  try {
    const fs = require('fs');
    fs.writeFileSync('./ai_chat_settings.json', JSON.stringify(settings, null, 2));
    console.log('✅ AI chat settings saved successfully');
  } catch (error) {
    console.error('❌ Error saving AI chat settings:', error);
  }
}

// Handle image-to-text functionality
async function handleImageToText(message) {
  try {
    // Check if image-to-text is enabled for this channel
    if (!image2textChannels.includes(message.channel.id)) {
      return;
    }

    for (const attachment of message.attachments.values()) {
      // Check if attachment is an image
      if (attachment.contentType && attachment.contentType.startsWith('image/')) {
        try {
          await message.channel.sendTyping();
          
          const extractedText = await extractTextFromImage(attachment.url);
          
          if (extractedText && extractedText !== "No text found in image") {
            const embed = new EmbedBuilder()
              .setColor(0x00AE86)
              .setTitle('📝 Text Extracted from Image')
              .setDescription(`**Extracted Text:**\n\`\`\`\n${extractedText}\`\`\``)
              .setThumbnail(attachment.url)
              .setFooter({ 
                text: `Requested by ${message.author.tag} • OCR Processing`,
                iconURL: message.author.displayAvatarURL()
              })
              .setTimestamp();

            await message.reply({ embeds: [embed] });
            console.log(`📝 OCR processed for ${message.author.tag}: ${extractedText.substring(0, 50)}...`);
          }
        } catch (ocrError) {
          console.error('OCR processing error:', ocrError);
        }
      }
    }
  } catch (error) {
    console.error('Image-to-text handler error:', error);
  }
}

// Enhanced Slash command handler
client.on('interactionCreate', async interaction => {
  // Handle button interactions for music player
  if (interaction.isButton()) {
    const customId = interaction.customId;
    
    if (customId.startsWith('music_')) {
      const player = localMusicPlayers.get(interaction.guild.id);
      const audioPlayer = player?.getAudioPlayer();
      
      if (!player) {
        await interaction.reply({ content: '❌ No music player active!', ephemeral: true });
        return;
      }

      try {
        switch (customId) {
          case 'music_previous':
            const prevResult = player.previous();
            if (prevResult.success && audioPlayer) {
              try {
                const audioResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name },
                  inlineVolume: true
                });
                if (audioResource.volume) {
                  audioResource.volume.setVolume(player.volume / 100);
                }
                
                // Remove old listeners to prevent conflicts
                audioPlayer.removeAllListeners(AudioPlayerStatus.Idle);
                
                // Play the new track
                audioPlayer.play(audioResource);
                player.isPlaying = true;
                player.isPaused = false;
                
                // Set up continuous playback for the new track
                const handleTrackEnd = async () => {
                  if (player.loop && player.getCurrentTrack()) {
                    // Loop current track
                    const loopResource = createAudioResource(player.getCurrentTrack().path, {
                      metadata: { title: player.getCurrentTrack().name },
                      inlineVolume: true
                    });
                    if (loopResource.volume) {
                      loopResource.volume.setVolume(player.volume / 100);
                    }
                    audioPlayer.removeAllListeners(AudioPlayerStatus.Idle);
                    audioPlayer.play(loopResource);
                    audioPlayer.once(AudioPlayerStatus.Idle, handleTrackEnd);
                  } else if (player.playlist.length > 1) {
                    // Continue to next track
                    const autoNextResult = player.nextTrack();
                    if (autoNextResult.success) {
                      const nextResource = createAudioResource(player.getCurrentTrack().path, {
                        metadata: { title: player.getCurrentTrack().name },
                        inlineVolume: true
                      });
                      if (nextResource.volume) {
                        nextResource.volume.setVolume(player.volume / 100);
                      }
                      audioPlayer.removeAllListeners(AudioPlayerStatus.Idle);
                      audioPlayer.play(nextResource);
                      audioPlayer.once(AudioPlayerStatus.Idle, handleTrackEnd);
                    }
                  }
                };
                
                // Attach the continuous playback handler
                audioPlayer.once(AudioPlayerStatus.Idle, handleTrackEnd);
                
                await interaction.update({ embeds: [player.getNowPlayingWidget()], components: player.getPlayerButtons() });
              } catch (error) {
                console.error('Error playing previous track:', error);
                await interaction.reply({ content: '❌ Failed to play previous track', ephemeral: true });
              }
            } else {
              await interaction.reply({ content: '❌ Cannot go to previous track', ephemeral: true });
            }
            break;

          case 'music_playpause':
            if (!audioPlayer) {
              await interaction.reply({ content: '❌ No audio player active!', ephemeral: true });
              return;
            }
            
            const isCurrentlyPaused = audioPlayer.state.status === AudioPlayerStatus.Paused;
            
            if (isCurrentlyPaused || player.isPaused) {
              audioPlayer.unpause();
              player.isPaused = false;
              player.isPlaying = true;
            } else if (audioPlayer.state.status === AudioPlayerStatus.Playing) {
              audioPlayer.pause();
              player.isPaused = true;
            }
            
            await interaction.update({ embeds: [player.getNowPlayingWidget().embeds[0]], components: player.getNowPlayingWidget().components });
            break;

          case 'music_next':
            const nextResult = player.nextTrack();
            if (nextResult.success && audioPlayer) {
              try {
                const audioResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name },
                  inlineVolume: true
                });
                if (audioResource.volume) {
                  audioResource.volume.setVolume(player.volume / 100);
                }
                
                // Remove old listeners to prevent conflicts
                audioPlayer.removeAllListeners(AudioPlayerStatus.Idle);
                
                // Play the new track
                audioPlayer.play(audioResource);
                player.isPlaying = true;
                player.isPaused = false;
                
                // Set up continuous playback for the new track
                const handleTrackEnd = async () => {
                  if (player.loop && player.getCurrentTrack()) {
                    // Loop current track
                    const loopResource = createAudioResource(player.getCurrentTrack().path, {
                      metadata: { title: player.getCurrentTrack().name },
                      inlineVolume: true
                    });
                    if (loopResource.volume) {
                      loopResource.volume.setVolume(player.volume / 100);
                    }
                    audioPlayer.removeAllListeners(AudioPlayerStatus.Idle);
                    audioPlayer.play(loopResource);
                    audioPlayer.once(AudioPlayerStatus.Idle, handleTrackEnd);
                  } else if (player.playlist.length > 1) {
                    // Continue to next track
                    const autoNextResult = player.nextTrack();
                    if (autoNextResult.success) {
                      const nextResource = createAudioResource(player.getCurrentTrack().path, {
                        metadata: { title: player.getCurrentTrack().name },
                        inlineVolume: true
                      });
                      if (nextResource.volume) {
                        nextResource.volume.setVolume(player.volume / 100);
                      }
                      audioPlayer.removeAllListeners(AudioPlayerStatus.Idle);
                      audioPlayer.play(nextResource);
                      audioPlayer.once(AudioPlayerStatus.Idle, handleTrackEnd);
                    }
                  }
                };
                
                // Attach the continuous playback handler
                audioPlayer.once(AudioPlayerStatus.Idle, handleTrackEnd);
                
                await interaction.update({ embeds: [player.getNowPlayingWidget()], components: player.getPlayerButtons() });
              } catch (error) {
                console.error('Error playing next track:', error);
                await interaction.reply({ content: '❌ Failed to play next track', ephemeral: true });
              }
            } else {
              await interaction.reply({ content: '❌ Cannot go to next track', ephemeral: true });
            }
            break;

          case 'music_volume_down':
            const volDownResult = player.volumeDown();
            if (audioPlayer && audioPlayer.state.resource && audioPlayer.state.resource.volume) {
              audioPlayer.state.resource.volume.setVolume(player.volume / 100);
            }
            await interaction.update({ embeds: [player.getNowPlayingWidget().embeds[0]], components: player.getNowPlayingWidget().components });
            break;

          case 'music_volume_up':
            const volUpResult = player.volumeUp();
            if (audioPlayer && audioPlayer.state.resource && audioPlayer.state.resource.volume) {
              audioPlayer.state.resource.volume.setVolume(player.volume / 100);
            }
            await interaction.update({ embeds: [player.getNowPlayingWidget().embeds[0]], components: player.getNowPlayingWidget().components });
            break;

          case 'music_loop':
            const loopResult = player.toggleLoop();
            
            // If there's an active audio player and we just enabled loop, prepare it for looping
            if (player.loop && audioPlayer && player.getCurrentTrack()) {
              console.log('🔁 Loop enabled via button - will loop current track when it ends');
            }
            
            // Update the widget to reflect the new loop state
            try {
              const updatedWidget = player.getNowPlayingWidget();
              await interaction.update({ embeds: [updatedWidget], components: player.getPlayerButtons() });
            } catch (error) {
              console.error('Error updating loop widget:', error);
              await interaction.reply({ content: `🔁 ${loopResult.message}`, ephemeral: true });
            }
            break;

          case 'music_shuffle':
            player.toggleShuffle();
            await interaction.update({ embeds: [player.getNowPlayingWidget().embeds[0]], components: player.getNowPlayingWidget().components });
            break;

          case 'music_refresh':
            try {
              const widget = player.getNowPlayingWidget();
              await interaction.update({ embeds: [widget], components: player.getPlayerButtons() });
            } catch (error) {
              console.error('Music refresh error:', error);
              await interaction.reply({ content: '❌ Failed to refresh widget.', ephemeral: true });
            }
            break;

          case 'music_start_playing':
            player.loadPlaylist();
            if (player.playlist.length > 0) {
              await interaction.reply({ content: '🎵 Use `/localplay` to start playing music from your library!', ephemeral: true });
            } else {
              await interaction.reply({ content: '❌ No music files found. Add music to your folders first!', ephemeral: true });
            }
            break;

          case 'music_shuffle_all':
            player.toggleShuffle();
            await interaction.reply({ 
              content: `🔀 **Shuffle Mode:** ${player.shuffle ? 'ENABLED' : 'DISABLED'}\n\n${player.shuffle ? '🎲 Your music will now play in random order!' : '📋 Music will play in normal order'}`,
              ephemeral: true 
            });
            break;

          case 'music_view_library_stats':
            await interaction.reply({ embeds: [player.getPlayerStats()], ephemeral: true });
            break;

          case 'music_settings_menu':
            await interaction.reply({ 
              content: '⚙️ **Custom Local Music Settings:**\n\n**Volume Controls:**\n🔊 `/localvolume set 75` - Set specific volume\n🔉 `/localvolume down` - Decrease volume\n🔊 `/localvolume up` - Increase volume\n\n**Playback Modes:**\n🔁 `/localloop` - Toggle loop mode\n🔀 `/localshuffle` - Toggle shuffle mode\n\n**Widgets:**\n🎵 `/localcustomnowplaying` - Show this widget\n📊 `/localstats` - View detailed statistics',
              ephemeral: true 
            });
            break;

          case 'music_show_playlist':
            await interaction.reply({ embeds: [player.getPlaylistEmbed()], ephemeral: true });
            break;

          case 'music_show_stats':
            await interaction.reply({ embeds: [player.getPlayerStats()], ephemeral: true });
            break;

          case 'music_play_custom':
            const customPlaylists = player.getCustomPlaylistsList();
            if (customPlaylists.length === 0) {
              await interaction.reply({ content: '❌ No custom playlists found! Use `/localaddtoplaylist` to create some first.', ephemeral: true });
            } else {
              const playlistList = customPlaylists.slice(0, 5).map((pl, index) => 
                `${index + 1}. **${pl.name}** (${pl.trackCount} tracks)`
              ).join('\n');
              await interaction.reply({ 
                content: `📝 **Available Custom Playlists:**\n\n${playlistList}\n\n🎵 Use \`/localcustomplay playlist:NAME\` to play a specific playlist!`,
                ephemeral: true 
              });
            }
            break;

          case 'music_show_custom_playlists':
            await interaction.reply({ embeds: [player.getCustomPlaylistsEmbed()], ephemeral: true });
            break;

          case 'music_create_playlist':
            await interaction.reply({ 
              content: '➕ **Create Custom Playlist:**\n\n🎵 Use `/localaddtoplaylist playlist:YOUR_PLAYLIST_NAME` to create a new playlist and add tracks!\n\n**Examples:**\n• `/localaddtoplaylist playlist:My Favorites`\n• `/localaddtoplaylist playlist:Workout Songs search:energy`\n• `/localaddtoplaylist playlist:Chill Music track:5`',
              ephemeral: true 
            });
            break;

          case 'music_start_custom_local':
            await interaction.reply({ 
              content: '🎵 **Start Custom Local Music:**\n\nChoose how to begin:\n• `/localplay` - Play from your music library\n• `/localcustomplay playlist:NAME` - Play a custom playlist\n• `/localplaylist-play` - Browse all playlists\n• `/localshuffle` - Enable shuffle mode first',
              ephemeral: true 
            });
            break;

          case 'music_browse_custom_playlists':
            await interaction.reply({ embeds: [player.getCustomPlaylistsEmbed()], ephemeral: true });
            break;

          case 'music_create_new_playlist':
            await interaction.reply({ 
              content: '➕ **Create New Custom Playlist:**\n\n**Quick Commands:**\n• `/localaddtoplaylist playlist:My New Playlist` - Add current track\n• `/localaddtoplaylist playlist:Favorites search:song_name` - Add by search\n• `/localaddtoplaylist playlist:Workout track:5` - Add specific track\n\n**Pro Tips:**\n🎵 Play music first, then add to playlists\n📝 Use descriptive playlist names\n🔍 Use search to find specific songs',
              ephemeral: true 
            });
            break;

          case 'music_shuffle_all':
            player.toggleShuffle();
            await interaction.reply({ 
              content: `🔀 **Shuffle Mode:** ${player.shuffle ? 'ENABLED' : 'DISABLED'}\n\n${player.shuffle ? '🎲 Your music will now play in random order!' : '📋 Music will play in normal order'}`,
              ephemeral: true 
            });
            break;

          case 'music_view_library_stats':
            await interaction.reply({ embeds: [player.getPlayerStats()], ephemeral: true });
            break;

          case 'music_settings_menu':
            await interaction.reply({ 
              content: '⚙️ **Custom Local Music Settings:**\n\n**Volume Controls:**\n🔊 `/localvolume set 75` - Set specific volume\n🔉 `/localvolume down` - Decrease volume\n🔊 `/localvolume up` - Increase volume\n\n**Playback Modes:**\n🔁 `/localloop` - Toggle loop mode\n🔀 `/localshuffle` - Toggle shuffle mode\n\n**Widgets:**\n🎵 `/localcustomnowplaying` - Show this widget\n📊 `/localstats` - View detailed statistics',
              ephemeral: true 
            });
            break;

          case 'music_add_to_custom_playlist':
            if (!player.getCurrentTrack()) {
              await interaction.reply({ content: '❌ No track currently playing to add to playlist!', ephemeral: true });
            } else {
              await interaction.reply({ 
                content: `➕ **Add "${player.getCurrentTrack().name}" to Custom Playlist:**\n\n**Quick Commands:**\n• \`/localaddtoplaylist playlist:Favorites\` - Add to Favorites\n• \`/localaddtoplaylist playlist:My Best Songs\` - Add to My Best Songs\n• \`/localaddtoplaylist playlist:Recently Played\` - Add to Recently Played\n\n**Current Track:** ${player.getCurrentTrack().name}\n**Format:** ${player.getCurrentTrack().extension.toUpperCase()} • **Size:** ${(player.getCurrentTrack().size / 1024 / 1024).toFixed(2)} MB`,
                ephemeral: true 
              });
            }
            break;

          case 'music_show_track_info':
            if (!player.getCurrentTrack()) {
              await interaction.reply({ content: '❌ No track currently playing!', ephemeral: true });
            } else {
              const track = player.getCurrentTrack();
              const progress = player.getCurrentProgress();
              const currentPlaylist = player.getCurrentPlaylistType();
              
              const trackInfoEmbed = new EmbedBuilder()
                .setColor(0x1DB954)
                .setTitle('🎵 Track Information')
                .setDescription(`**Currently Playing:** ${track.name}`)
                .addFields(
                  { name: '📁 File Details', value: `**Filename:** ${track.filename}\n**Format:** ${track.extension.toUpperCase()}\n**Size:** ${(track.size / 1024 / 1024).toFixed(2)} MB\n**Duration:** ${track.duration}`, inline: true },
                  { name: '📊 Playback Info', value: `**Progress:** ${progress.current} / ${progress.total}\n**Completion:** ${progress.percentage}%\n**Position:** ${player.currentIndex + 1} of ${player.playlist.length}`, inline: true },
                  { name: '📝 Playlist Info', value: currentPlaylist ? `**Custom Playlist:** ${currentPlaylist}` : '**Source:** Default Library', inline: false },
                  { name: '📁 File Location', value: `\`${track.path}\``, inline: false }
                )
                .setFooter({ text: 'Custom Local Music Player • Track Information' })
                .setTimestamp();
              
              await interaction.reply({ embeds: [trackInfoEmbed], ephemeral: true });
            }
            break;

          case 'music_refresh_widget':
            try {
              const customWidget = player.getCustomLocalNowPlayingWidget();
              await interaction.update({ 
                embeds: customWidget.embeds, 
                components: customWidget.components 
              });
            } catch (error) {
              console.error('Custom widget refresh error:', error);
              await interaction.reply({ content: '❌ Failed to refresh custom widget.', ephemeral: true });
            }
            break;

          case 'icon_refresh_scan':
            try {
              const iconManager = player.getIconManager();
              const refreshResult = iconManager.forceRefresh();
              
              const embed = iconManager.getIconManagerEmbed();
              if (refreshResult.success) {
                embed.addFields({
                  name: '🔄 Auto-Update Status',
                  value: `✅ File watcher active\n📁 ${refreshResult.totalFileCount} files scanned\n🎨 ${refreshResult.customIconCount} custom icons loaded\n⚡ Auto-update enabled`,
                  inline: false
                });
              }
              
              await interaction.update({ 
                embeds: [embed], 
                components: iconManager.getIconManagerButtons() 
              });
            } catch (error) {
              console.error('Icon refresh scan error:', error);
              await interaction.reply({ content: '❌ Failed to refresh icon scan.', ephemeral: true });
            }
            break;

          case 'icon_show_gallery':
            const galleryEmbed = player.getIconManager().getIconGallery(1);
            await interaction.reply({ embeds: [galleryEmbed], ephemeral: true });
            break;

          case 'icon_reset_all':
            const resetResult = player.getIconManager().resetAllIcons();
            if (resetResult.success) {
              await interaction.reply({ 
                content: `✅ ${resetResult.message}`,
                ephemeral: true 
              });
            } else {
              await interaction.reply({ 
                content: `❌ ${resetResult.message}`,
                ephemeral: true 
              });
            }
            break;

          case 'icon_help':
            const helpEmbed = new EmbedBuilder()
              .setColor(0x1DB954)
              .setTitle('📝 Icon Upload Help')
              .setDescription('**How to Upload Custom Icons:**\n\n**Method 1: Slash Command**\n• Use `/iconupload type:ICON_TYPE` with an attachment\n• Select the icon type from the dropdown\n• Upload PNG, JPG, JPEG, GIF, or WEBP files (max 2MB)\n\n**Method 2: Drag & Drop**\n• Open your file manager\n• Navigate to the `assets/player-icons/` folder\n• Drag and drop icon files into the appropriate subfolders:\n   - `buttons/` - For button icons\n   - `backgrounds/` - For background images\n   - `animations/` - For animated GIFs\n\n**File Requirements:**\n• **Formats:** PNG, JPG, JPEG, GIF, WEBP\n• **Size:** Maximum 2MB per file\n• **Dimensions:** 24x24px to 64x64px recommended for buttons\n• **Names:** Use descriptive names for organization')
              .addFields(
                { name: '🎨 Icon Types Available', value: 'play, pause, previous, next, volumeDown, volumeUp, loop, shuffle, stop, refresh', inline: false },
                { name: '📁 Folder Structure', value: '```\nassets/player-icons/\n├── buttons/\n├── backgrounds/\n├── animations/\n└── icon-config.json\n```', inline: false }
              )
              .setFooter({ text: 'Custom Icon Manager • Upload Help' })
              .setTimestamp();
            await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
            break;

          case 'icon_export_config':
            const configPath = './assets/player-icons/icon-config.json';
            if (fs.existsSync(configPath)) {
              await interaction.reply({ 
                content: '💾 **Icon Configuration Exported**\nYour icon configuration has been saved to `assets/player-icons/icon-config.json`\n\nYou can share this file with others or use it as a backup!',
                files: [configPath],
                ephemeral: true 
              });
            } else {
              await interaction.reply({ 
                content: '❌ No icon configuration found to export.',
                ephemeral: true 
              });
            }
            break;

          case 'icon_import_config':
            await interaction.reply({ 
              content: '📥 **Import Icon Configuration**\n\nTo import a configuration:\n1. Use `/iconupload` to upload individual icons\n2. Or manually place the `icon-config.json` file in the `assets/player-icons/` folder\n3. Then use the "Refresh Icons" button to reload\n\n**Note:** Make sure all referenced icon files exist in the correct folders!',
              ephemeral: true 
            });
            break;

          case 'music_stop_and_clear':
            const stopResult = player.stop();
            if (audioPlayer) {
              audioPlayer.stop();
            }
            await interaction.reply({ 
              content: '⏹️ **Music Stopped**\n\nPlayback has been stopped and cleared.\n\n🎵 Use `/localplay` to start playing music again\n📝 Use `/localcustomplay` to play custom playlists',
              ephemeral: true 
            });
            break;

          case 'music_add_to_playlist':
            if (!player.getCurrentTrack()) {
              await interaction.reply({ content: '❌ No track currently playing to add to playlist!', ephemeral: true });
            } else {
              await interaction.reply({ 
                content: `➕ **Add "${player.getCurrentTrack().name}" to Playlist:**\n\nUse \`/localaddtoplaylist playlist:YOUR_PLAYLIST_NAME\` to add the current track to a playlist!\n\n**Quick Commands:**\n• \`/localaddtoplaylist playlist:Favorites\` - Add to Favorites\n• \`/localaddtoplaylist playlist:Recently Played\` - Add to Recently Played`,
                ephemeral: true 
              });
            }
            break;

          case 'music_track_random':
            if (player.playlist.length === 0) {
              await interaction.reply({ content: '❌ No tracks available!', ephemeral: true });
              return;
            }
            const randomIndex = Math.floor(Math.random() * player.playlist.length);
            const randomResult = player.play(randomIndex);
            if (randomResult.success && audioPlayer) {
              const audioResource = createAudioResource(player.getCurrentTrack().path, {
                metadata: { title: player.getCurrentTrack().name }
              });
              if (audioResource.volume) {
                audioResource.volume.setVolume(player.volume / 100);
              }
              audioPlayer.play(audioResource);
              player.isPlaying = true;
              player.isPaused = false;
              
              const updatedWidget = player.getCompactWidgetWithTrackSelection();
              await interaction.update({ embeds: updatedWidget.embeds, components: updatedWidget.components });
            } else {
              await interaction.reply({ content: '❌ Failed to play random track', ephemeral: true });
            }
            break;

          case 'music_track_page_prev':
            // Go to previous page
            if (player.previousTrackPage()) {
              try {
                const updatedWidget = player.getCompactWidgetWithTrackSelection();
                await interaction.update({ embeds: updatedWidget.embeds, components: updatedWidget.components });
              } catch (error) {
                console.error('Track page navigation error:', error);
                await interaction.reply({ content: '❌ Failed to navigate tracks.', ephemeral: true });
              }
            } else {
              await interaction.reply({ content: '❌ Already on first page.', ephemeral: true });
            }
            break;

          case 'music_track_page_next':
            // Go to next page
            if (player.nextTrackPage()) {
              try {
                const updatedWidget = player.getCompactWidgetWithTrackSelection();
                await interaction.update({ embeds: updatedWidget.embeds, components: updatedWidget.components });
              } catch (error) {
                console.error('Track page navigation error:', error);
                await interaction.reply({ content: '❌ Failed to navigate tracks.', ephemeral: true });
              }
            } else {
              await interaction.reply({ content: '❌ Already on last page.', ephemeral: true });
            }
            break;

          default:
            // Handle track selection buttons
            if (customId.startsWith('music_play_track_')) {
              const trackIndex = parseInt(customId.split('_')[3]);
              if (isNaN(trackIndex) || trackIndex < 0 || trackIndex >= player.playlist.length) {
                await interaction.reply({ content: '❌ Invalid track selection!', ephemeral: true });
                return;
              }

              // Stop current audio if playing
              if (audioPlayer && audioPlayer.state.status !== 'idle') {
                audioPlayer.stop();
              }

              // Set the new track using the correct index
              const trackResult = player.play(trackIndex);
              if (trackResult.success && audioPlayer) {
                try {
                  const selectedTrack = player.getCurrentTrack();
                  const audioResource = createAudioResource(selectedTrack.path, {
                    metadata: { title: selectedTrack.name }
                  });
                  if (audioResource.volume) {
                    audioResource.volume.setVolume(player.volume / 100);
                  }
                  
                  // Play the new track
                  audioPlayer.play(audioResource);
                  player.isPlaying = true;
                  player.isPaused = false;
                  
                  // Update the widget to reflect the new track
                  const updatedWidget = player.getCompactWidgetWithTrackSelection();
                  await interaction.update({ embeds: updatedWidget.embeds, components: updatedWidget.components });
                  
                  // Send feedback about track change
                  setTimeout(async () => {
                    try {
                      await interaction.followUp({ 
                        content: `🎵 **Now Playing:** ${selectedTrack.name}\n📍 **Track ${trackIndex + 1}** of ${player.playlist.length}`,
                        ephemeral: true 
                      });
                    } catch (error) {
                      console.error('Track switch feedback error:', error);
                    }
                  }, 1000);
                  
                } catch (error) {
                  console.error('Track play error:', error);
                  await interaction.reply({ content: '❌ Failed to play selected track. Please try again.', ephemeral: true });
                }
              } else {
                await interaction.reply({ content: `❌ ${trackResult.message}`, ephemeral: true });
              }
            } else if (customId === 'music_track_info') {
              // Handle track info button (disabled info button)
              await interaction.reply({ content: '📊 Track position information', ephemeral: true });
            } else if (customId === 'music_empty_slot') {
              // Handle empty slot button (should be disabled)
              await interaction.reply({ content: '❌ Empty slot', ephemeral: true });
            } else if (customId.startsWith('play_custom_playlist_')) {
              // Handle custom playlist quick play buttons
              const playlistName = customId.replace('play_custom_playlist_', '');
              const member = interaction.member;
              const voiceChannel = member.voice.channel;

              if (!voiceChannel) {
                await interaction.reply({ content: '❌ You need to be in a voice channel to play music!', ephemeral: true });
                return;
              }

              try {
                // Load the custom playlist
                const customPlaylist = player.loadCustomPlaylistByName(playlistName);
                if (customPlaylist.length === 0) {
                  await interaction.reply({ content: `❌ Custom playlist "${playlistName}" is empty or not found!`, ephemeral: true });
                  return;
                }

                // Join voice channel if not connected
                let connection = voiceConnections.get(interaction.guild.id);
                if (!connection) {
                  const { joinVoiceChannel } = require('@discordjs/voice');
                  connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guild.id,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                  });
                  voiceConnections.set(interaction.guild.id, connection);
                }

                player.setVoiceConnection(connection);

                // Start playing first track
                const result = player.play(0);
                if (result.success) {
                  const audioResource = createAudioResource(player.getCurrentTrack().path, {
                    metadata: { title: player.getCurrentTrack().name }
                  });
                  if (audioResource.volume) {
                    audioResource.volume.setVolume(player.volume / 100);
                  }
                  
                  const audioPlayer = player.getAudioPlayer();
                  audioPlayer.play(audioResource);
                  connection.subscribe(audioPlayer);
                  player.isPlaying = true;
                  player.isPaused = false;

                  const successEmbed = new EmbedBuilder()
                    .setColor(0x1DB954)
                    .setTitle('🎵 Custom Playlist Started')
                    .setDescription(`**${playlistName}**\n\n**Now Playing:** ${player.getCurrentTrack().name}`)
                    .addFields(
                      { name: '📊 Playlist Size', value: `${customPlaylist.length} tracks`, inline: true },
                      { name: '🎤 Voice Channel', value: voiceChannel.name, inline: true },
                      { name: '📍 Position', value: `Track 1 of ${customPlaylist.length}`, inline: true }
                    )
                    .setFooter({ text: `Custom Playlist: ${playlistName} • Use music controls to navigate` })
                    .setTimestamp();

                  await interaction.reply({ embeds: [successEmbed] });
                } else {
                  await interaction.reply({ content: `❌ Failed to start playlist: ${result.message}`, ephemeral: true });
                }
              } catch (error) {
                console.error('Custom playlist play error:', error);
                await interaction.reply({ content: '❌ Error playing custom playlist. Please try again.', ephemeral: true });
              }
            } else {
              await interaction.reply({ content: '❌ Unknown button interaction!', ephemeral: true });
            }
            break;
        }
      } catch (error) {
        console.error('Button interaction error:', error);
        await interaction.reply({ content: '❌ An error occurred while processing the button action.', ephemeral: true });
      }
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    // Check if server is authenticated (skip for auth and unauthenticate commands)
    if (commandName !== 'auth' && commandName !== 'unauthenticate' && !isServerAuthenticated(interaction.guild.id)) {
      await interaction.reply({
        content: '**Authentication Required from Script**',
        ephemeral: true
      });
      return;
    }

    if (!checkCooldown(interaction.user.id)) {
      await interaction.reply({
        content: '⏰ Please wait a moment before using another command.',
        ephemeral: true
      });
      return;
    }

    

    // Enhanced Image generation command
    if (commandName === 'imageprompt') {
      await interaction.deferReply();
      const prompt = interaction.options.getString('prompt');

      try {
        const imageUrl = await generateImage(prompt);

        if (imageUrl) {
          const embed = new EmbedBuilder()
            .setColor(0x00AE86)
            .setTitle('🎨 AI Generated Image')
            .setDescription(`**Prompt:** ${prompt}`)
            .setImage(imageUrl)
            .setFooter({ text: 'Generated by Hercai AI • High Quality Enhanced' })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          try {
            const dmEmbed = new EmbedBuilder()
              .setColor(0xFF6B35)
              .setTitle('🚨 Image Generation Failed')
              .setDescription(`Hello ${interaction.user.tag}!\n\nYour image generation request failed in **${interaction.guild.name}**.`)
              .addFields(
                { name: 'Failed Prompt', value: prompt, inline: false },
                { name: 'Possible Solutions', value: '• Try a different prompt\n• Avoid complex or inappropriate content\n• Try again in a few minutes\n• Use simpler, more descriptive words', inline: false },
                { name: 'Server', value: interaction.guild.name, inline: true },
                { name: 'Channel', value: interaction.channel.name, inline: true }
              )
              .setFooter({ text: 'AI Image Generation Service' })
              .setTimestamp();

            await interaction.user.send({ embeds: [dmEmbed] });
            console.log(`📩 Sent failure DM to ${interaction.user.tag}`);
          } catch (dmError) {
            console.error('Failed to send DM:', dmError.message);
          }

          await interaction.editReply(`❌ ${interaction.user}, failed to generate image. I've sent you a DM with more details and suggestions!`);
        }
      } catch (error) {
        console.error('Image generation error:', error);
        
        try {
          const errorDmEmbed = new EmbedBuilder()
            .setColor(0xDC143C)
            .setTitle('⚠️ Image Generation Error')
            .setDescription(`Hello ${interaction.user.tag}!\n\nThere was a technical error with your image generation request in **${interaction.guild.name}**.`)
            .addFields(
              { name: 'Your Prompt', value: prompt, inline: false },
              { name: 'Error Details', value: 'The AI service is temporarily unavailable or overloaded.', inline: false },
              { name: 'What to do', value: '• Wait a few minutes and try again\n• Try a shorter, simpler prompt\n• Check if the service is experiencing issues\n• Contact support if the problem persists', inline: false },
              { name: 'Server', value: interaction.guild.name, inline: true },
              { name: 'Channel', value: interaction.channel.name, inline: true }
            )
            .setFooter({ text: 'AI Image Generation Service • Error Report' })
            .setTimestamp();

          await interaction.user.send({ embeds: [errorDmEmbed] });
          console.log(`📩 Sent error DM to ${interaction.user.tag}`);
        } catch (dmError) {
          console.error('Failed to send error DM:', dmError.message);
        }

        await interaction.editReply(`❌ ${interaction.user}, image generation service is temporarily unavailable. I've sent you a DM with more information!`);
      }
      return;
    }

    // Compliment command
    if (commandName === 'compliment') {
      const compliments = [
        "You're absolutely amazing! ✨",
        "Your positive energy is contagious! 🌟",
        "You have such a kind heart! 💕",
        "You're incredibly talented! 🎯",
        "Your smile could light up the whole room! 😊",
        "You're one of a kind! 🦋",
        "You make the world a better place! 🌍",
        "You're stronger than you know! 💪",
        "Your creativity knows no bounds! 🎨",
        "You're absolutely wonderful! 🌈"
      ];
      const randomCompliment = compliments[Math.floor(Math.random() * compliments.length)];
      await interaction.reply(randomCompliment);
      return;
    }

    

    // Fixed Help command
    if (commandName === 'help') {
      try {
        const helpEmbed = new EmbedBuilder()
          .setColor(0x00AE86)
          .setTitle('🤖 Enhanced Bot Commands - AI, Music & Moderation!')
          .setDescription('Here are all the available commands:')
          .addFields(
            {
              name: '🎨 Fun Commands',
              value: '• `/gif [search]` - Send random GIFs\n• `/say <message>` - Make bot say something (supports media!)\n• `/greet <user>` - Greet a user with customizable styles\n• `/compliment` - Get a sweet compliment\n• `/ping` - Check bot latency',
              inline: false
            },
            
            {
              name: '🎵 Local Music Commands',
              value: '• `/localplay [search] [track]` - Play local music\n• `/localpause` - Pause/resume playback\n• `/localnext` - Next track\n• `/localprevious` - Previous track\n• `/localvolume set/up/down` - Control volume\n• `/localloop` - Toggle loop mode\n• `/localshuffle` - Toggle shuffle\n• `/localnowplaying` - Show current track\n• `/localplaylist [page]` - Show playlist\n• `/localstats` - Player statistics',
              inline: false
            },
            {
              name: '📝 Custom Playlist Commands',
              value: '• `/pplay playlist:NAME` - Play custom playlist\n• `/plist` - View all playlists\n• `/pladd` - Add track to playlist\n• `/paddmulti` - Add multiple tracks\n• `/paddall` - Add all tracks\n• `/prename` - Rename playlist\n• `/pnow` - Show now playing\n• `/pfix` - Fix/update playlist',
              inline: false
            },
            {
              name: '🎮 Music Player Widgets',
              value: '• `/localnowplaying` - Standard music player widget\n• `/localcustomnowplaying` - Enhanced custom widget\n• `/localcompactwidget` - Compact widget with track selection\n• `/localwidget` - Basic control widget',
              inline: false
            },
            {
              name: '🎵 Voice Commands',
              value: '• `/join` - Join your voice channel\n• `/leave` - Leave voice channel\n• `/tts <message> [voice]` - Text-to-speech\n• `/echo <message>` - Echo/repeat sounds with customizable options',
              inline: false
            },
            {
              name: '🛡️ Moderation Commands',
              value: '• `/kick <user> [reason]` - Kick member\n• `/ban <user> [reason] [days]` - Ban member\n• `/unban <userid> [reason]` - Unban user\n• `/timeout <user> <duration> [reason]` - Timeout member\n• `/untimeout <user> [reason]` - Remove timeout\n• `/warn <user> <reason>` - Warn member\n• `/clear <amount> [user]` - Delete messages\n• `/lock [channel] [reason]` - Lock channel\n• `/unlock [channel] [reason]` - Unlock channel\n• `/slowmode <seconds> [channel]` - Set slowmode\n• `/antinuke` - Anti-nuke protection',
              inline: false
            },
            {
              name: '📊 Information Commands',
              value: '• `/userinfo [user]` - User information\n• `/serverinfo` - Server information\n• `/uptime` - Bot uptime & monitoring stats\n• `/help` - Show this help menu\n• `/developer` - Developer info',
              inline: false
            },
            {
              name: '🔧 Administrative Commands',
              value: '• `/restart [reason]` - Restart the bot (Admin only)\n• `/iconmanager` - Manage custom icons with auto-update\n• `/antinuke` - Anti-nuke protection settings\n• `/aistart` - Enable server-wide AI chat (Admin only)\n• `/aistop` - Disable server-wide AI chat (Admin only)\n• `/aistatus` - Check AI chat status (Admin only)',
              inline: false
            },
            {
              name: '📤 DM Commands',
              value: '• `/dm <user> <message>` - Send a direct message\n• `/dmlink <user> <link>` - Send a link via DM\n• `/dmimage <user> <image>` - Send an image via DM\n• `/dmvideo <user> <video>` - Send a video via DM\n• `/dmembed <user> <title> <description>` - Send an embed via DM\n• All DM commands support anonymous mode',
              inline: false
            }
          )
          .setThumbnail(client.user.displayAvatarURL())
          .setFooter({
            text: 'Enhanced Bot with AI, Music & Security • Made by Script from ScriptSpace',
            iconURL: client.user.displayAvatarURL()
          })
          .setTimestamp();

        await interaction.reply({ embeds: [helpEmbed] });
      } catch (error) {
        console.error('Help command error:', error);
        await interaction.reply({ content: '❌ Failed to display help menu.', ephemeral: true });
      }
      return;
    }

    // Developer command
    if (commandName === 'developer') {
      const userId = interaction.user.id;
      const now = Date.now();
      const lastUsed = developerCommandCooldowns.get(userId);

      if (lastUsed && (now - lastUsed) < DEVELOPER_COOLDOWN_TIME) {
        await interaction.reply({
          content: '👨‍💻 **Developer:** Script from ScriptSpace\n🌐 **Support:** discord.gg/scriptspace\n⚡ **Status:** Enhanced with Music & AI!',
          ephemeral: true
        });
        return;
      }

      developerCommandCooldowns.set(userId, now);

      const devEmbed = new EmbedBuilder()
        .setColor(0x7289DA)
        .setTitle('👨‍💻 Developer Information')
        .setDescription('This enhanced bot was created by **Script from ScriptSpace**')
        .addFields(
          { name: '👨‍💻 Developer', value: 'Script from ScriptSpace', inline: true },
          { name: '🌐 Support Server', value: '[discord.gg/scriptspace](https://discord.gg/scriptspace)', inline: true },
          { name: '💻 Language', value: 'JavaScript (Node.js)', inline: true },
          { name: '📚 Libraries', value: 'Discord.js v14, Hercai AI, Tesseract.js, Voice', inline: true },
          { name: '⚡ Features', value: 'AI Chat, Music Player, Moderation, Anti-Nuke', inline: true },
          { name: '🚀 Status', value: 'Enhanced & Optimized for Performance!', inline: true }
        )
        .setThumbnail(client.user.displayAvatarURL())
        .setFooter({
          text: 'Enhanced Bot • Made with ❤️ by Script from ScriptSpace',
          iconURL: client.user.displayAvatarURL()
        })
        .setTimestamp();

      await interaction.reply({ embeds: [devEmbed] });
      return;
    }

    // GIF command
    if (commandName === 'gif') {
      await interaction.deferReply();
      const searchTerm = interaction.options.getString('search') || 'funny';

      try {
        const gif = await getRandomGif(searchTerm, 'medium');

        if (gif) {
          const embed = new EmbedBuilder()
            .setColor(0x00AE86)
            .setTitle(`🎭 ${gif.title}`)
            .setImage(gif.url)
            .setFooter({ text: 'Powered by Tenor' });

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply('❌ No GIFs found for that search term.');
        }
      } catch (error) {
        console.error('GIF command error:', error);
        await interaction.editReply('❌ Failed to fetch GIF. Please try again.');
      }
      return;
    }

    // Fixed Ping command
    if (commandName === 'ping') {
      const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;

      const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle('🏓 Pong!')
        .addFields(
          { name: 'Bot Latency', value: `${latency}ms`, inline: true },
          { name: 'API Latency', value: `${Math.round(client.ws.ping)}ms`, inline: true },
          { name: 'Status', value: '⚡ Enhanced & Fast!', inline: true },
          { name: 'Uptime', value: `<t:${Math.floor((Date.now() - client.uptime) / 1000)}:R>`, inline: true },
          { name: 'Memory Usage', value: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, inline: true },
          { name: 'Features', value: 'AI + Music + Moderation', inline: true }
        )
        .setTimestamp();

      await interaction.editReply({ content: '', embeds: [embed] });
      return;
    }

    // Enhanced Say command with media support
    if (commandName === 'say') {
      const message = interaction.options.getString('message');
      const targetChannel = interaction.options.getChannel('channel');
      const useEmbed = interaction.options.getBoolean('embed') || false;
      const image = interaction.options.getAttachment('image');
      const video = interaction.options.getAttachment('video');
      const file = interaction.options.getAttachment('file');
      const link = interaction.options.getString('link');
      
      // Allow links in say command but validate them
      const bannedWords = ['@everyone', '@here'];
      const lowerMessage = message.toLowerCase();
      
      if (bannedWords.some(word => lowerMessage.includes(word))) {
        await interaction.reply({
          content: '❌ I cannot say messages that contain @everyone or @here mentions.',
          ephemeral: true
        });
        return;
      }

      if (message.length > 2000) {
        await interaction.reply({
          content: '❌ Message is too long! Please keep it under 2000 characters.',
          ephemeral: true
        });
        return;
      }

      // Validate link if provided
      if (link && !link.startsWith('http://') && !link.startsWith('https://')) {
        await interaction.reply({
          content: '❌ Invalid link format. Links must start with http:// or https://',
          ephemeral: true
        });
        return;
      }

      // Validate media files
      const validImageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
      const validVideoTypes = ['video/mp4', 'video/mov', 'video/avi', 'video/webm', 'video/mkv'];

      if (image && (!image.contentType || !validImageTypes.includes(image.contentType))) {
        await interaction.reply({
          content: '❌ Invalid image format. Supported: PNG, JPG, JPEG, GIF, WEBP',
          ephemeral: true
        });
        return;
      }

      if (video && (!video.contentType || !validVideoTypes.includes(video.contentType))) {
        await interaction.reply({
          content: '❌ Invalid video format. Supported: MP4, MOV, AVI, WEBM, MKV',
          ephemeral: true
        });
        return;
      }

      // Check file sizes (8MB limit)
      const attachments = [image, video, file].filter(Boolean);
      for (const attachment of attachments) {
        if (attachment.size > 8 * 1024 * 1024) {
          await interaction.reply({
            content: '❌ File is too large. Maximum size is 8MB per file.',
            ephemeral: true
          });
          return;
        }
      }

      const channelToSend = targetChannel || interaction.channel;

      if (targetChannel && !targetChannel.permissionsFor(interaction.guild.members.me).has(PermissionFlagsBits.SendMessages)) {
        await interaction.reply({
          content: '❌ I don\'t have permission to send messages in that channel.',
          ephemeral: true
        });
        return;
      }

      try {
        let finalMessage = message;
        if (link) {
          finalMessage += `\n\n🔗 **Link:** ${link}`;
        }

        const messageOptions = {
          content: finalMessage || undefined,
          files: []
        };

        // Add attachments
        if (image) {
          messageOptions.files.push({
            attachment: image.url,
            name: image.name
          });
        }
        if (video) {
          messageOptions.files.push({
            attachment: video.url,
            name: video.name
          });
        }
        if (file) {
          messageOptions.files.push({
            attachment: file.url,
            name: file.name
          });
        }

        if (useEmbed) {
          const embed = new EmbedBuilder()
            .setColor(0x00AE86)
            .setDescription(finalMessage)
            .setFooter({
              text: `Requested by ${interaction.user.tag}`,
              iconURL: interaction.user.displayAvatarURL()
            })
            .setTimestamp();

          // Set image if provided
          if (image) {
            embed.setImage(image.url);
            messageOptions.files = messageOptions.files.filter(f => f.name !== image.name);
          }

          messageOptions.embeds = [embed];
          messageOptions.content = undefined;
        }

        // Send the message
        await channelToSend.send(messageOptions);

        // Build confirmation message
        let confirmMessage = '✅ Message sent';
        const mediaInfo = [];
        if (image) mediaInfo.push('🖼️ Image');
        if (video) mediaInfo.push('🎥 Video');
        if (file) mediaInfo.push('📁 File');
        if (link) mediaInfo.push('🔗 Link');
        
        if (mediaInfo.length > 0) {
          confirmMessage += ` with ${mediaInfo.join(', ')}`;
        }

        if (targetChannel && targetChannel.id !== interaction.channel.id) {
          confirmMessage += ` to ${targetChannel}!`;
        } else {
          confirmMessage += '!';
        }

        await interaction.reply({
          content: confirmMessage,
          ephemeral: true
        });

      } catch (error) {
        console.error('Enhanced say command error:', error);
        await interaction.reply({
          content: '❌ Failed to send the message. Please check my permissions and file formats.',
          ephemeral: true
        });
      }
      return;
    }

    // Greet command
    if (commandName === 'greet') {
      const targetUser = interaction.options.getUser('user');
      const customMessage = interaction.options.getString('message');
      const style = interaction.options.getString('style') || 'friendly';
      const shouldMention = interaction.options.getBoolean('mention') || false;
      const useEmbed = interaction.options.getBoolean('embed') || false;

      if (targetUser.id === interaction.user.id) {
        await interaction.reply({
          content: '❌ You cannot greet yourself! That would be a bit awkward 😅',
          ephemeral: true
        });
        return;
      }

      if (targetUser.bot) {
        await interaction.reply({
          content: '❌ Bots don\'t need greetings, they\'re always happy to serve! 🤖',
          ephemeral: true
        });
        return;
      }

      // Predefined greeting styles
      const greetingStyles = {
        friendly: {
          emoji: '👋',
          messages: [
            'Hey there! Welcome and nice to meet you!',
            'Hello! Great to have you here!',
            'Hi! Hope you\'re having a wonderful day!',
            'Hey! Welcome to our awesome community!',
            'Hello there! So glad you could join us!'
          ]
        },
        excited: {
          emoji: '🎉',
          messages: [
            'OMG! Welcome! This is so exciting!',
            'WOOHOO! You\'re here! Party time!',
            'YAY! Welcome aboard! Let\'s celebrate!',
            'AMAZING! You made it! So pumped to have you!',
            'WOW! Welcome! This is going to be epic!'
          ]
        },
        professional: {
          emoji: '💼',
          messages: [
            'Good day! Welcome to our community.',
            'Greetings! We\'re pleased to have you join us.',
            'Hello! Welcome to our professional environment.',
            'Good to see you! Welcome aboard.',
            'Greetings and welcome to our team!'
          ]
        },
        welcoming: {
          emoji: '🌟',
          messages: [
            'Welcome home! You belong here!',
            'Step right in! You\'re family now!',
            'Welcome with open arms! So happy you\'re here!',
            'Come on in! Make yourself comfortable!',
            'Welcome to your new favorite place!'
          ]
        },
        gaming: {
          emoji: '🎮',
          messages: [
            'Player joined the server! Welcome, gamer!',
            'New challenger approaching! Welcome!',
            'Achievement unlocked: New member! Welcome!',
            'Respawn complete! Welcome to the game!',
            'Level up! Welcome to our guild!'
          ]
        },
        motivational: {
          emoji: '🚀',
          messages: [
            'Welcome, future legend! Your journey starts here!',
            'You\'re destined for greatness! Welcome aboard!',
            'Ready to conquer new heights? Welcome!',
            'The adventure begins now! Welcome, champion!',
            'Your success story starts here! Welcome!'
          ]
        }
      };

      const selectedStyle = greetingStyles[style];
      const randomMessage = selectedStyle.messages[Math.floor(Math.random() * selectedStyle.messages.length)];
      const greeting = customMessage || randomMessage;

      try {
        if (useEmbed) {
          const embed = new EmbedBuilder()
            .setColor(0x00AE86)
            .setTitle(`${selectedStyle.emoji} Greeting from ${interaction.user.tag}`)
            .setDescription(greeting)
            .addFields(
              { name: 'Greeted User', value: targetUser.tag, inline: true },
              { name: 'Style', value: `${selectedStyle.emoji} ${style.charAt(0).toUpperCase() + style.slice(1)}`, inline: true },
              { name: 'Server', value: interaction.guild.name, inline: true }
            )
            .setThumbnail(targetUser.displayAvatarURL())
            .setFooter({
              text: `Greeting sent by ${interaction.user.tag}`,
              iconURL: interaction.user.displayAvatarURL()
            })
            .setTimestamp();

          const content = shouldMention ? `${targetUser}` : undefined;
          await interaction.reply({ content, embeds: [embed] });
        } else {
          const userReference = shouldMention ? `${targetUser}` : `**${targetUser.tag}**`;
          const message = `${selectedStyle.emoji} ${userReference} ${greeting}`;
          await interaction.reply(message);
        }

        // Send confirmation if it's an embed or if user wasn't mentioned
        if (useEmbed || !shouldMention) {
          setTimeout(async () => {
            try {
              await interaction.followUp({
                content: `✅ Greeting sent to ${targetUser.tag} with ${style} style!`,
                ephemeral: true
              });
            } catch (error) {
              console.error('Greet confirmation error:', error);
            }
          }, 1000);
        }

      } catch (error) {
        console.error('Greet command error:', error);
        await interaction.reply({
          content: '❌ Failed to send greeting. Please check my permissions.',
          ephemeral: true
        });
      }
      return;
    }

    // Fixed Moderation Commands

    // Kick command
    if (commandName === 'kick') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.KickMembers)) {
        await interaction.reply({ content: '❌ You need the "Kick Members" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) {
        await interaction.reply({ content: '❌ I need the "Kick Members" permission to perform this action.', ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const targetMember = interaction.guild.members.cache.get(targetUser.id);

      if (!targetMember) {
        await interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });
        return;
      }

      if (targetMember.id === interaction.user.id) {
        await interaction.reply({ content: '❌ You cannot kick yourself.', ephemeral: true });
        return;
      }

      if (targetMember.id === client.user.id) {
        await interaction.reply({ content: '❌ I cannot kick myself.', ephemeral: true });
        return;
      }

      if (targetMember.roles.highest.position >= interaction.member.roles.highest.position) {
        await interaction.reply({ content: '❌ You cannot kick someone with equal or higher roles.', ephemeral: true });
        return;
      }

      if (targetMember.roles.highest.position >= interaction.guild.members.me.roles.highest.position) {
        await interaction.reply({ content: '❌ I cannot kick someone with equal or higher roles than me.', ephemeral: true });
        return;
      }

      try {
        await targetMember.kick(reason);
        const embed = new EmbedBuilder()
          .setColor(0xFF6B35)
          .setTitle('👢 Member Kicked')
          .addFields(
            { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
            { name: 'Reason', value: reason, inline: false }
          )
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error('Kick error:', error);
        await interaction.reply({ content: '❌ Failed to kick the user. Check my permissions and role hierarchy.', ephemeral: true });
      }
      return;
    }

    // Ban command
    if (commandName === 'ban') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) {
        await interaction.reply({ content: '❌ You need the "Ban Members" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
        await interaction.reply({ content: '❌ I need the "Ban Members" permission to perform this action.', ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const days = interaction.options.getInteger('days') || 0;
      const targetMember = interaction.guild.members.cache.get(targetUser.id);

      if (targetMember) {
        if (targetMember.id === interaction.user.id) {
          await interaction.reply({ content: '❌ You cannot ban yourself.', ephemeral: true });
          return;
        }

        if (targetMember.id === client.user.id) {
          await interaction.reply({ content: '❌ I cannot ban myself.', ephemeral: true });
          return;
        }

        if (targetMember.roles.highest.position >= interaction.member.roles.highest.position) {
          await interaction.reply({ content: '❌ You cannot ban someone with equal or higher roles.', ephemeral: true });
          return;
        }

        if (targetMember.roles.highest.position >= interaction.guild.members.me.roles.highest.position) {
          await interaction.reply({ content: '❌ I cannot ban someone with equal or higher roles than me.', ephemeral: true });
          return;
        }
      }

      try {
        await interaction.guild.members.ban(targetUser.id, { deleteMessageDays: days, reason: reason });
        const embed = new EmbedBuilder()
          .setColor(0xDC143C)
          .setTitle('🔨 Member Banned')
          .addFields(
            { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
            { name: 'Reason', value: reason, inline: false },
            { name: 'Messages Deleted', value: `${days} day(s)`, inline: true }
          )
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error('Ban error:', error);
        await interaction.reply({ content: '❌ Failed to ban the user. Check my permissions and role hierarchy.', ephemeral: true });
      }
      return;
    }

    // Unban command
    if (commandName === 'unban') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) {
        await interaction.reply({ content: '❌ You need the "Ban Members" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
        await interaction.reply({ content: '❌ I need the "Ban Members" permission to perform this action.', ephemeral: true });
        return;
      }

      const userId = interaction.options.getString('userid');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      try {
        const bannedUser = await interaction.guild.bans.fetch(userId);
        await interaction.guild.members.unban(userId, reason);
        
        const embed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setTitle('🔓 Member Unbanned')
          .addFields(
            { name: 'User', value: `${bannedUser.user.tag} (${bannedUser.user.id})`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
            { name: 'Reason', value: reason, inline: false }
          )
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error('Unban error:', error);
        await interaction.reply({ content: '❌ Failed to unban the user. Make sure they are banned and the ID is correct.', ephemeral: true });
      }
      return;
    }

    // Timeout command
    if (commandName === 'timeout') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await interaction.reply({ content: '❌ You need the "Moderate Members" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await interaction.reply({ content: '❌ I need the "Moderate Members" permission to perform this action.', ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user');
      const durationString = interaction.options.getString('duration');
      const duration = parseInt(durationString);
      const reason = interaction.options.getString('reason') || 'No reason provided';

      // Fetch the member from the guild
      let targetMember;
      try {
        targetMember = await interaction.guild.members.fetch(targetUser.id);
      } catch (error) {
        console.error('Failed to fetch member:', error);
        await interaction.reply({ content: '❌ User not found in this server or unable to fetch member data.', ephemeral: true });
        return;
      }

      if (!targetMember) {
        await interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });
        return;
      }

      if (targetMember.id === interaction.user.id) {
        await interaction.reply({ content: '❌ You cannot timeout yourself.', ephemeral: true });
        return;
      }

      if (targetMember.id === client.user.id) {
        await interaction.reply({ content: '❌ I cannot timeout myself.', ephemeral: true });
        return;
      }

      // Check if user is the server owner
      if (targetMember.id === interaction.guild.ownerId) {
        await interaction.reply({ content: '❌ You cannot timeout the server owner.', ephemeral: true });
        return;
      }

      // Check if target member has administrator permission
      if (targetMember.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ You cannot timeout a user with Administrator permissions.', ephemeral: true });
        return;
      }

      // Check role hierarchy
      if (targetMember.roles.highest.position >= interaction.member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId) {
        await interaction.reply({ content: '❌ You cannot timeout someone with equal or higher roles than you.', ephemeral: true });
        return;
      }

      if (targetMember.roles.highest.position >= interaction.guild.members.me.roles.highest.position) {
        await interaction.reply({ content: '❌ I cannot timeout someone with equal or higher roles than me.', ephemeral: true });
        return;
      }

      // Check if user is already timed out
      if (targetMember.isCommunicationDisabled()) {
        await interaction.reply({ content: '❌ This user is already timed out. Use `/untimeout` to remove the existing timeout first.', ephemeral: true });
        return;
      }

      // Validate duration
      if (isNaN(duration) || duration <= 0) {
        await interaction.reply({ content: '❌ Invalid duration specified.', ephemeral: true });
        return;
      }

      // Check if duration exceeds Discord's maximum (28 days)
      const maxMinutes = 28 * 24 * 60; // 28 days in minutes
      if (duration > maxMinutes) {
        await interaction.reply({ content: '❌ Timeout duration cannot exceed 28 days (40,320 minutes).', ephemeral: true });
        return;
      }

      try {
        // Apply timeout with proper duration calculation
        const timeoutDuration = duration * 60 * 1000; // Convert minutes to milliseconds
        await targetMember.timeout(timeoutDuration, reason);

        // Format duration display
        const durationDisplay = {
          '1': '1 minute',
          '5': '5 minutes', 
          '10': '10 minutes',
          '60': '1 hour',
          '300': '5 hours',
          '10080': '7 days',
          '43200': '1 month (30 days)'
        }[durationString] || `${duration} minute(s)`;

        // Calculate timeout end time
        const timeoutEnd = new Date(Date.now() + timeoutDuration);

        const embed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle('⏰ Member Timed Out Successfully')
          .addFields(
            { name: '👤 User', value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: true },
            { name: '⏱️ Duration', value: durationDisplay, inline: true },
            { name: '👮 Moderator', value: `${interaction.user.tag}`, inline: true },
            { name: '📝 Reason', value: reason, inline: false },
            { name: '⏰ Timeout Ends', value: `<t:${Math.floor(timeoutEnd.getTime() / 1000)}:F>`, inline: false }
          )
          .setThumbnail(targetUser.displayAvatarURL())
          .setFooter({ text: `Timeout applied in ${interaction.guild.name}` })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });

        // Try to send DM to the user
        try {
          const dmEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('⏰ You have been timed out')
            .addFields(
              { name: 'Server', value: interaction.guild.name, inline: true },
              { name: 'Duration', value: durationDisplay, inline: true },
              { name: 'Moderator', value: interaction.user.tag, inline: true },
              { name: 'Reason', value: reason, inline: false },
              { name: 'Timeout Ends', value: `<t:${Math.floor(timeoutEnd.getTime() / 1000)}:F>`, inline: false }
            )
            .setFooter({ text: 'This timeout will be automatically removed when the duration expires.' })
            .setTimestamp();

          await targetUser.send({ embeds: [dmEmbed] });
        } catch (dmError) {
          console.log(`Could not send timeout DM to ${targetUser.tag}: ${dmError.message}`);
        }

      } catch (error) {
        console.error('Timeout error:', error);
        
        let errorMessage = '❌ Failed to timeout the user. ';
        
        if (error.code === 50013) {
          errorMessage += 'Missing permissions. Make sure I have the "Moderate Members" permission and my role is higher than the target user.';
        } else if (error.code === 50035) {
          errorMessage += 'Invalid timeout duration provided.';
        } else if (error.code === 10007) {
          errorMessage += 'Unknown member - the user may have left the server.';
        } else if (error.code === 50001) {
          errorMessage += 'Missing access to perform this action.';
        } else {
          errorMessage += `Error: ${error.message}`;
        }

        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
      return;
    }

    // Untimeout command
    if (commandName === 'untimeout') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await interaction.reply({ content: '❌ You need the "Moderate Members" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await interaction.reply({ content: '❌ I need the "Moderate Members" permission to perform this action.', ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const targetMember = interaction.guild.members.cache.get(targetUser.id);

      if (!targetMember) {
        await interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });
        return;
      }

      if (!targetMember.isCommunicationDisabled()) {
        await interaction.reply({ content: '❌ This user is not currently timed out.', ephemeral: true });
        return;
      }

      try {
        await targetMember.timeout(null, reason);
        const embed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setTitle('✅ Timeout Removed')
          .addFields(
            { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
            { name: 'Reason', value: reason, inline: false }
          )
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error('Untimeout error:', error);
        await interaction.reply({ content: '❌ Failed to remove timeout. Check my permissions.', ephemeral: true });
      }
      return;
    }

    // Warn command
    if (commandName === 'warn') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await interaction.reply({ content: '❌ You need the "Moderate Members" permission to use this command.', ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const targetMember = interaction.guild.members.cache.get(targetUser.id);

      if (!targetMember) {
        await interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });
        return;
      }

      if (targetMember.id === interaction.user.id) {
        await interaction.reply({ content: '❌ You cannot warn yourself.', ephemeral: true });
        return;
      }

      try {
        try {
          await targetUser.send(`⚠️ **Warning from ${interaction.guild.name}**\n**Moderator:** ${interaction.user.tag}\n**Reason:** ${reason}`);
        } catch (dmError) {
          console.log('Could not send DM to user');
        }

        const embed = new EmbedBuilder()
          .setColor(0xFFFF00)
          .setTitle('⚠️ Member Warned')
          .addFields(
            { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
            { name: 'Reason', value: reason, inline: false }
          )
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error('Warn error:', error);
        await interaction.reply({ content: '❌ Failed to warn the user.', ephemeral: true });
      }
      return;
    }

    // Clear command
    if (commandName === 'clear') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ I need the "Manage Messages" permission to perform this action.', ephemeral: true });
        return;
      }

      const amount = interaction.options.getInteger('amount');
      const targetUser = interaction.options.getUser('user');

      try {
        const messages = await interaction.channel.messages.fetch({ limit: amount + 1 });
        let messagesToDelete = messages;

        if (targetUser) {
          messagesToDelete = messages.filter(msg => msg.author.id === targetUser.id);
        }

        const deletedMessages = await interaction.channel.bulkDelete(messagesToDelete, true);
        
        const embed = new EmbedBuilder()
          .setColor(0x00AE86)
          .setTitle('🧹 Messages Cleared')
          .addFields(
            { name: 'Messages Deleted', value: `${deletedMessages.size}`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true }
          )
          .setTimestamp();

        if (targetUser) {
          embed.addFields({ name: 'Target User', value: `${targetUser.tag}`, inline: true });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (error) {
        console.error('Clear error:', error);
        await interaction.reply({ content: '❌ Failed to delete messages. Messages older than 14 days cannot be bulk deleted.', ephemeral: true });
      }
      return;
    }

    // Lock command
    if (commandName === 'lock') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: '❌ You need the "Manage Channels" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: '❌ I need the "Manage Channels" permission to perform this action.', ephemeral: true });
        return;
      }

      const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
      const reason = interaction.options.getString('reason') || 'No reason provided';

      try {
        await targetChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
          SendMessages: false
        });

        const embed = new EmbedBuilder()
          .setColor(0xDC143C)
          .setTitle('🔒 Channel Locked')
          .addFields(
            { name: 'Channel', value: `${targetChannel}`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
            { name: 'Reason', value: reason, inline: false }
          )
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error('Lock error:', error);
        await interaction.reply({ content: '❌ Failed to lock the channel. Check my permissions.', ephemeral: true });
      }
      return;
    }

    // Unlock command
    if (commandName === 'unlock') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: '❌ You need the "Manage Channels" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: '❌ I need the "Manage Channels" permission to perform this action.', ephemeral: true });
        return;
      }

      const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
      const reason = interaction.options.getString('reason') || 'No reason provided';

      try {
        await targetChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
          SendMessages: null
        });

        const embed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setTitle('🔓 Channel Unlocked')
          .addFields(
            { name: 'Channel', value: `${targetChannel}`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
            { name: 'Reason', value: reason, inline: false }
          )
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error('Unlock error:', error);
        await interaction.reply({ content: '❌ Failed to unlock the channel. Check my permissions.', ephemeral: true });
      }
      return;
    }

    // Slowmode command
    if (commandName === 'slowmode') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: '❌ You need the "Manage Channels" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ content: '❌ I need the "Manage Channels" permission to perform this action.', ephemeral: true });
        return;
      }

      const seconds = interaction.options.getInteger('seconds');
      const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

      try {
        await targetChannel.setRateLimitPerUser(seconds);
        
        const embed = new EmbedBuilder()
          .setColor(0x00AE86)
          .setTitle('🐌 Slowmode Updated')
          .addFields(
            { name: 'Channel', value: `${targetChannel}`, inline: true },
            { name: 'Duration', value: seconds === 0 ? 'Disabled' : `${seconds} second(s)`, inline: true },
            { name: 'Moderator', value: `${interaction.user.tag}`, inline: true }
          )
          .setTimestamp();
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error('Slowmode error:', error);
        await interaction.reply({ content: '❌ Failed to set slowmode. Check my permissions.', ephemeral: true });
      }
      return;
    }

    // Userinfo command
    if (commandName === 'userinfo') {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const targetMember = interaction.guild.members.cache.get(targetUser.id);

      const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle(`👤 User Information - ${targetUser.tag}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: 'Username', value: targetUser.tag, inline: true },
          { name: 'User ID', value: targetUser.id, inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:F>`, inline: false }
        )
        .setTimestamp();

      if (targetMember) {
        embed.addFields(
          { name: 'Joined Server', value: `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:F>`, inline: false },
          { name: 'Roles', value: targetMember.roles.cache.filter(role => role.id !== interaction.guild.id).map(role => role.toString()).join(', ') || 'None', inline: false },
          { name: 'Highest Role', value: targetMember.roles.highest.toString(), inline: true },
          { name: 'Status', value: targetMember.presence?.status || 'Offline', inline: true }
        );
      }

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // Serverinfo command
    if (commandName === 'serverinfo') {
      const guild = interaction.guild;
      
      const embed = new EmbedBuilder()
        .setColor(0x00AE86)
        .setTitle(`🏰 Server Information - ${guild.name}`)
        .setThumbnail(guild.iconURL())
        .addFields(
          { name: 'Server Name', value: guild.name, inline: true },
          { name: 'Server ID', value: guild.id, inline: true },
          { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
          { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false },
          { name: 'Members', value: guild.memberCount.toString(), inline: true },
          { name: 'Channels', value: guild.channels.cache.size.toString(), inline: true },
          { name: 'Roles', value: guild.roles.cache.size.toString(), inline: true },
          { name: 'Verification Level', value: guild.verificationLevel.toString(), inline: true },
          { name: 'Boost Level', value: `Level ${guild.premiumTier}`, inline: true },
          { name: 'Boost Count', value: guild.premiumSubscriptionCount?.toString() || '0', inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // Anti-nuke command
    if (commandName === 'antinuke') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ You need Administrator permission to use anti-nuke commands.', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      switch (subcommand) {
        case 'status':
          const statusEmbed = new EmbedBuilder()
            .setColor(antiNukeConfig.enabled ? 0x00FF00 : 0xFF0000)
            .setTitle('🛡️ Anti-Nuke Status')
            .addFields(
              { name: 'Status', value: antiNukeConfig.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
              { name: 'Punishment', value: antiNukeConfig.punishmentType, inline: true },
              { name: 'Log Channel', value: antiNukeConfig.logChannelId ? `<#${antiNukeConfig.logChannelId}>` : 'Not set', inline: true },
              { name: 'Channel Delete Limit', value: antiNukeConfig.maxChannelDeletes.toString(), inline: true },
              { name: 'Role Delete Limit', value: antiNukeConfig.maxRoleDeletes.toString(), inline: true },
              { name: 'Ban Limit', value: antiNukeConfig.maxBans.toString(), inline: true },
              { name: 'Kick Limit', value: antiNukeConfig.maxKicks.toString(), inline: true },
              { name: 'Time Window', value: `${antiNukeConfig.timeWindow / 1000}s`, inline: true },
              { name: 'Whitelisted Users', value: antiNukeConfig.whitelistedUsers.length.toString(), inline: true }
            )
            .setTimestamp();
          await interaction.reply({ embeds: [statusEmbed] });
          break;

        case 'toggle':
          const enabled = interaction.options.getBoolean('enabled');
          antiNukeConfig.enabled = enabled;
          await interaction.reply(`🛡️ Anti-nuke has been **${enabled ? 'enabled' : 'disabled'}**.`);
          break;

        case 'whitelist':
          const userToWhitelist = interaction.options.getUser('user');
          if (!antiNukeConfig.whitelistedUsers.includes(userToWhitelist.id)) {
            antiNukeConfig.whitelistedUsers.push(userToWhitelist.id);
            await interaction.reply(`✅ Added ${userToWhitelist.tag} to anti-nuke whitelist.`);
          } else {
            await interaction.reply(`❌ ${userToWhitelist.tag} is already whitelisted.`);
          }
          break;

        case 'unwhitelist':
          const userToUnwhitelist = interaction.options.getUser('user');
          const index = antiNukeConfig.whitelistedUsers.indexOf(userToUnwhitelist.id);
          if (index > -1) {
            antiNukeConfig.whitelistedUsers.splice(index, 1);
            await interaction.reply(`✅ Removed ${userToUnwhitelist.tag} from anti-nuke whitelist.`);
          } else {
            await interaction.reply(`❌ ${userToUnwhitelist.tag} is not whitelisted.`);
          }
          break;

        case 'logchannel':
          const logChannel = interaction.options.getChannel('channel');
          antiNukeConfig.logChannelId = logChannel.id;
          await interaction.reply(`✅ Set anti-nuke log channel to ${logChannel}.`);
          break;

        case 'punishment':
          const punishmentType = interaction.options.getString('type');
          antiNukeConfig.punishmentType = punishmentType;
          await interaction.reply(`✅ Set anti-nuke punishment to **${punishmentType}**.`);
          break;
      }
      return;
    }

    

    // Join voice channel command
    if (commandName === 'join') {
      const member = interaction.member;
      const voiceChannel = member.voice.channel;

      if (!voiceChannel) {
        await interaction.reply({
          content: '❌ You need to be in a voice channel first!',
          ephemeral: true
        });
        return;
      }

      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        voiceConnections.set(interaction.guild.id, connection);

        connection.on(VoiceConnectionStatus.Ready, () => {
          console.log('Voice connection ready!');
        });

        connection.on(VoiceConnectionStatus.Disconnected, () => {
          console.log('Voice connection disconnected');
          voiceConnections.delete(interaction.guild.id);
        });

        await interaction.reply({
          content: `✅ Joined **${voiceChannel.name}**!`,
          ephemeral: false
        });
      } catch (error) {
        console.error('Join voice error:', error);
        await interaction.reply({
          content: '❌ Failed to join voice channel. Make sure I have proper permissions.',
          ephemeral: true
        });
      }
      return;
    }

    // Leave voice channel command
    if (commandName === 'leave') {
      const connection = voiceConnections.get(interaction.guild.id);

      if (!connection) {
        await interaction.reply({
          content: '❌ I\'m not connected to any voice channel!',
          ephemeral: true
        });
        return;
      }

      try {
        connection.destroy();
        voiceConnections.delete(interaction.guild.id);

        // Clear music queue if exists
        const queue = musicQueues.get(interaction.guild.id);
        if (queue) {
          queue.isPlaying = false;
          queue.currentSong = null;
          queue.songs = [];
        }

        await interaction.reply({
          content: '✅ Left the voice channel and cleared music queue!',
          ephemeral: false
        });
      } catch (error) {
        console.error('Leave voice error:', error);
        await interaction.reply({
          content: '❌ Failed to leave voice channel.',
          ephemeral: true
        });
      }
      return;
    }

    // Text-to-speech command
    if (commandName === 'tts') {
      const message = interaction.options.getString('message');
      const voice = interaction.options.getString('voice') || 'female';
      const connection = voiceConnections.get(interaction.guild.id);

      if (!connection) {
        await interaction.reply({
          content: '❌ I need to be in a voice channel first! Use `/join` to connect me.',
          ephemeral: true
        });
        return;
      }

      if (message.length > 200) {
        await interaction.reply({
          content: '❌ Message is too long! Please keep it under 200 characters.',
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply();

      try {
        const audioUrl = await textToSpeech(message, voice);
        
        if (!audioUrl) {
          await interaction.editReply('❌ Failed to generate speech audio.');
          return;
        }

        const resource = createAudioResource(audioUrl);
        const player = createAudioPlayer();

        player.play(resource);
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Playing, () => {
          console.log('TTS audio is playing');
        });

        player.on(AudioPlayerStatus.Idle, () => {
          console.log('TTS audio finished');
        });

        player.on('error', (error) => {
          console.error('Audio player error:', error);
        });

        await interaction.editReply({
          content: `🔊 **Speaking:** "${message}" (${voice} voice)`
        });

      } catch (error) {
        console.error('TTS command error:', error);
        await interaction.editReply('❌ Failed to play text-to-speech audio.');
      }
      return;
    }

    // Echo command - repeats sounds with customizable options
    if (commandName === 'echo') {
      const message = interaction.options.getString('message');
      const repeatCount = interaction.options.getInteger('repeat') || 3;
      const voice = interaction.options.getString('voice') || 'female';
      const delay = interaction.options.getInteger('delay') || 2;
      const connection = voiceConnections.get(interaction.guild.id);

      if (!connection) {
        await interaction.reply({
          content: '❌ I need to be in a voice channel first! Use `/join` to connect me.',
          ephemeral: true
        });
        return;
      }

      if (message.length > 150) {
        await interaction.reply({
          content: '❌ Echo message is too long! Please keep it under 150 characters for better echo effect.',
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply();

      try {
        // Generate initial TTS audio
        const audioUrl = await textToSpeech(message, voice);
        
        if (!audioUrl) {
          await interaction.editReply('❌ Failed to generate echo audio.');
          return;
        }

        // Send confirmation with echo details
        const embed = new EmbedBuilder()
          .setColor(0x1DB954)
          .setTitle('🔊 Echo Sound Started')
          .setDescription(`**Message:** "${message}"`)
          .addFields(
            { name: '🔁 Repeat Count', value: repeatCount.toString(), inline: true },
            { name: '🎤 Voice Type', value: voice.charAt(0).toUpperCase() + voice.slice(1), inline: true },
            { name: '⏱️ Delay', value: `${delay} seconds`, inline: true },
            { name: '📊 Total Duration', value: `~${(repeatCount * 3) + (delay * (repeatCount - 1))} seconds`, inline: true },
            { name: '🎵 Echo Pattern', value: `Play → Wait ${delay}s → Repeat`, inline: true },
            { name: '⏹️ Status', value: '🟢 Echo in progress...', inline: true }
          )
          .setFooter({ text: 'Echo Sound System • Repeating message with delays' })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // Create audio player for echo sequence
        const echoPlayer = createAudioPlayer();
        connection.subscribe(echoPlayer);

        let currentRepeat = 0;
        
        const playEcho = async () => {
          if (currentRepeat >= repeatCount) {
            console.log(`Echo sequence completed for: "${message}"`);
            
            // Send completion notification
            try {
              const completionEmbed = new EmbedBuilder()
                .setColor(0x00AE86)
                .setTitle('✅ Echo Sequence Completed')
                .setDescription(`**Message:** "${message}"`)
                .addFields(
                  { name: '🔁 Total Repeats', value: repeatCount.toString(), inline: true },
                  { name: '⏱️ Total Duration', value: `${Math.floor((Date.now() - startTime) / 1000)} seconds`, inline: true },
                  { name: '📊 Status', value: '🔴 Echo finished', inline: true }
                )
                .setFooter({ text: 'Echo Sound System • Sequence completed successfully' })
                .setTimestamp();

              await interaction.followUp({ embeds: [completionEmbed] });
            } catch (followUpError) {
              console.error('Echo completion notification error:', followUpError);
            }
            return;
          }

          currentRepeat++;
          console.log(`Playing echo ${currentRepeat}/${repeatCount}: "${message}"`);

          try {
            // Generate fresh audio for each echo to avoid caching issues
            const echoAudioUrl = await textToSpeech(message, voice);
            
            if (echoAudioUrl) {
              const echoResource = createAudioResource(echoAudioUrl);
              echoPlayer.play(echoResource);

              // Schedule next echo after current one finishes + delay
              echoPlayer.once(AudioPlayerStatus.Idle, () => {
                if (currentRepeat < repeatCount) {
                  setTimeout(() => {
                    playEcho();
                  }, delay * 1000);
                } else {
                  playEcho(); // Final call to trigger completion
                }
              });

              // Send progress update every 2 echoes
              if (currentRepeat % 2 === 0 && currentRepeat < repeatCount) {
                try {
                  const progressEmbed = new EmbedBuilder()
                    .setColor(0xFFAA00)
                    .setTitle('🔄 Echo Progress Update')
                    .setDescription(`**Message:** "${message}"`)
                    .addFields(
                      { name: '📊 Progress', value: `${currentRepeat}/${repeatCount} echoes completed`, inline: true },
                      { name: '⏱️ Elapsed Time', value: `${Math.floor((Date.now() - startTime) / 1000)}s`, inline: true },
                      { name: '🔁 Status', value: '🟡 Echo in progress...', inline: true }
                    )
                    .setFooter({ text: 'Echo Sound System • Progress update' })
                    .setTimestamp();

                  await interaction.followUp({ embeds: [progressEmbed] });
                } catch (progressError) {
                  console.error('Echo progress notification error:', progressError);
                }
              }
            } else {
              console.error(`Failed to generate echo audio for repeat ${currentRepeat}`);
              // Skip this repeat and continue
              setTimeout(() => {
                playEcho();
              }, delay * 1000);
            }
          } catch (playError) {
            console.error(`Echo play error on repeat ${currentRepeat}:`, playError);
            // Continue with next echo even if current one fails
            setTimeout(() => {
              playEcho();
            }, delay * 1000);
          }
        };

        // Handle player errors
        echoPlayer.on('error', (error) => {
          console.error('Echo player error:', error);
        });

        // Start the echo sequence
        const startTime = Date.now();
        playEcho();

      } catch (error) {
        console.error('Echo command error:', error);
        await interaction.editReply('❌ Failed to start echo sequence. Please try again.');
      }
      return;
    }

    // Local Music Player Commands

    // Local play command
    if (commandName === 'localplay') {
      const member = interaction.member;
      const voiceChannel = member.voice.channel;

      if (!voiceChannel) {
        await interaction.reply({
          content: '❌ You need to be in a voice channel to play local music!',
          ephemeral: true
        });
        return;
      }

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      await interaction.deferReply();

      try {
        const search = interaction.options.getString('search');
        const trackNumber = interaction.options.getInteger('track');

        // Load playlist with search if provided
        const playlist = player.loadPlaylist(search);
        
        if (playlist.length === 0) {
          await interaction.editReply({
            content: search ? 
              `❌ No music files found matching "${search}"! Try different keywords or add more music files.` :
              '❌ No music files found! Add .mp3, .wav, .ogg, .m4a, or .flac files to your music folders.',
            ephemeral: true
          });
          return;
        }

        // If search was provided but no specific track, show search results
        if (search && !trackNumber) {
          const searchResults = player.searchTracks(search, 'keywords', 10, true);
          if (searchResults.length > 0) {
            const searchEmbed = player.getSearchResultsEmbed(searchResults, search, 'keywords', true);
            searchEmbed.addFields({
              name: '🎵 How to Play',
              value: `Use \`/localplay track:NUMBER\` to play a specific track\nExample: \`/localplay track:1\` to play the first result`,
              inline: false
            });
            await interaction.editReply({ embeds: [searchEmbed] });
            return;
          }
        }

        // Join voice channel
        let connection = voiceConnections.get(interaction.guild.id);
        if (!connection) {
          connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
          });
          voiceConnections.set(interaction.guild.id, connection);

          connection.on(VoiceConnectionStatus.Ready, () => {
            console.log('Voice connection ready for local music!');
          });

          connection.on(VoiceConnectionStatus.Disconnected, () => {
            console.log('Voice connection disconnected');
            voiceConnections.delete(interaction.guild.id);
          });
        }

        // Set voice connection on player
        player.setVoiceConnection(connection);

        // Play specific track or first track
        const result = player.play(trackNumber ? trackNumber - 1 : 0);
        
        if (result.success) {
          // Create audio resource from local file
          const audioResource = createAudioResource(player.getCurrentTrack().path, {
            metadata: {
              title: player.getCurrentTrack().name
            },
            inlineVolume: true
          });

          // Create and configure audio player
          const audioPlayer = createAudioPlayer();
          
          // Set volume before playing
          if (audioResource.volume) {
            audioResource.volume.setVolume(player.volume / 100);
          }

          // Play and subscribe
          audioPlayer.play(audioResource);
          connection.subscribe(audioPlayer);

          // Handle player events
          audioPlayer.on(AudioPlayerStatus.Playing, async () => {
            console.log(`🎵 Now playing local track: ${player.getCurrentTrack().name}`);
            
            // Update player state to reflect actual playback
            player.isPlaying = true;
            player.isPaused = false;
            
            // Send updated "Now Playing" widget with full functionality
            try {
              const enhancedWidget = player.getNowPlayingWidget()
                .addFields(
                  { name: '🎤 Voice Channel', value: voiceChannel.name, inline: true },
                  { name: '📁 File Location', value: `\`${player.getCurrentTrack().path}\``, inline: false },
                  { name: '💾 File Size', value: `${(player.getCurrentTrack().size / 1024 / 1024).toFixed(2)} MB`, inline: true },
                  { name: '🔧 Format', value: player.getCurrentTrack().extension.toUpperCase(), inline: true },
                  { name: '🎯 Quick Actions', value: '**Essential Controls:**\n⏯️ Use `/localpause` to pause\n⏭️ Use `/localnext` for next track\n🔊 Use `/localvolume up` to increase volume\n📝 Use `/localplaylist` to see all tracks', inline: false }
                )
                .setTitle('🎵 Local Music Player - Now Playing')
                .setColor(0x00FF00);
              
              await interaction.followUp({ embeds: [enhancedWidget] });
            } catch (error) {
              console.error('Error sending enhanced now playing widget:', error);
            }
          });

          audioPlayer.on(AudioPlayerStatus.Idle, async () => {
            console.log('🎵 Local track finished, checking for next track...');
            
            if (player.loop && player.getCurrentTrack()) {
              // Loop current track
              try {
                console.log('🔁 Looping current track:', player.getCurrentTrack().name);
                const loopResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name },
                  inlineVolume: true
                });
                if (loopResource.volume) {
                  loopResource.volume.setVolume(player.volume / 100);
                }
                audioPlayer.play(loopResource);
                player.isPlaying = true;
                player.isPaused = false;
                
                // Send loop notification
                try {
                  const loopEmbed = new EmbedBuilder()
                    .setColor(0x1DB954)
                    .setTitle('🔁 Track Looping')
                    .setDescription(`**${player.getCurrentTrack().name}** is now looping`)
                    .setTimestamp();
                  await interaction.followUp({ embeds: [loopEmbed] });
                } catch (error) {
                  console.error('Error sending loop notification:', error);
                }
              } catch (error) {
                console.error('Error looping track:', error);
                player.isPlaying = false;
              }
            } else if (player.playlist.length > 1 && player.currentIndex < player.playlist.length - 1) {
              // Auto-play next track if available and not at end
              const nextResult = player.nextTrack();
              if (nextResult.success) {
                try {
                  console.log('⏭️ Auto-playing next track:', player.getCurrentTrack().name);
                  const nextResource = createAudioResource(player.getCurrentTrack().path, {
                    metadata: { title: player.getCurrentTrack().name },
                    inlineVolume: true
                  });
                  if (nextResource.volume) {
                    nextResource.volume.setVolume(player.volume / 100);
                  }
                  audioPlayer.play(nextResource);
                  player.isPlaying = true;
                  player.isPaused = false;
                  
                  // Send auto-next notification
                  try {
                    const autoNextEmbed = new EmbedBuilder()
                      .setColor(0x1DB954)
                      .setTitle('⏭️ Auto-Playing Next Track')
                      .setDescription(`**${player.getCurrentTrack().name}**`)
                      .addFields(
                        { name: 'Position', value: `${player.currentIndex + 1}/${player.playlist.length}`, inline: true },
                        { name: 'Duration', value: player.getCurrentTrack().duration, inline: true }
                      )
                      .setTimestamp();
                    await interaction.followUp({ embeds: [autoNextEmbed] });
                  } catch (error) {
                    console.error('Error sending auto-next notification:', error);
                  }
                } catch (error) {
                  console.error('Error playing next track:', error);
                  player.isPlaying = false;
                }
              } else {
                // End of playlist - check if we should loop playlist
                if (player.playlist.length > 1) {
                  console.log('📻 End of playlist reached, restarting from beginning');
                  player.currentIndex = 0;
                  player.currentTrack = player.playlist[0];
                  
                  try {
                    const restartResource = createAudioResource(player.getCurrentTrack().path, {
                      metadata: { title: player.getCurrentTrack().name },
                      inlineVolume: true
                    });
                    if (restartResource.volume) {
                      restartResource.volume.setVolume(player.volume / 100);
                    }
                    audioPlayer.play(restartResource);
                    player.isPlaying = true;
                    player.isPaused = false;
                    
                    // Send restart notification
                    try {
                      const restartEmbed = new EmbedBuilder()
                        .setColor(0x1DB954)
                        .setTitle('🔄 Playlist Restarted')
                        .setDescription(`**${player.getCurrentTrack().name}**\n\nRestarting from the beginning of the playlist`)
                        .addFields(
                          { name: 'Position', value: `1/${player.playlist.length}`, inline: true },
                          { name: 'Auto-Loop', value: 'Continuous playback enabled', inline: true }
                        )
                        .setTimestamp();
                      await interaction.followUp({ embeds: [restartEmbed] });
                    } catch (error) {
                      console.error('Error sending restart notification:', error);
                    }
                  } catch (error) {
                    console.error('Error restarting playlist:', error);
                    player.isPlaying = false;
                  }
                } else {
                  player.isPlaying = false;
                }
              }
            } else {
              // Single track finished or at end of playlist
              console.log('📻 Playback finished');
              player.isPlaying = false;
              
              try {
                const endEmbed = new EmbedBuilder()
                  .setColor(0x636363)
                  .setTitle('📻 Playback Finished')
                  .setDescription('Use `/localplay` to start again or `/localloop` to enable track repeat.')
                  .setTimestamp();
                await interaction.followUp({ embeds: [endEmbed] });
              } catch (error) {
                console.error('Error sending end notification:', error);
              }
            }
          });

          audioPlayer.on(AudioPlayerStatus.Paused, () => {
            console.log('🎵 Local music paused');
            player.isPaused = true;
          });

          audioPlayer.on('error', (error) => {
            console.error('Local audio player error:', error);
            player.isPlaying = false;
            player.isPaused = false;
          });

          // Store the audio player for control commands
          player.setAudioPlayer(audioPlayer);

          // Send immediate confirmation with full music player widget
          const musicPlayerWidget = player.getNowPlayingWidget()
            .addFields(
              { name: '🎤 Voice Channel', value: voiceChannel.name, inline: true },
              { name: '📁 File Location', value: `\`${player.getCurrentTrack().path}\``, inline: false },
              { name: '💾 File Size', value: `${(player.getCurrentTrack().size / 1024 / 1024).toFixed(2)} MB`, inline: true },
              { name: '🔧 Format', value: player.getCurrentTrack().extension.toUpperCase(), inline: true }
            )
            .setDescription(`**${player.getCurrentTrack().name}**\n\n**🎮 Full Music Player Controls:**\n⏮️ \`/localprevious\` - Previous track\n⏸️ \`/localpause\` - Pause/Resume\n⏭️ \`/localnext\` - Skip to next\n🔊 \`/localvolume up/down/set\` - Volume control\n🔁 \`/localloop\` - Toggle loop mode\n🔀 \`/localshuffle\` - Toggle shuffle\n📝 \`/localplaylist\` - View full playlist\n📊 \`/localstats\` - Player statistics\n🎵 \`/localnowplaying\` - Refresh this widget`)
            .setColor(0x1DB954)
            .setTitle('🎵 Local Music Player - Now Loading');

          await interaction.editReply({ embeds: [musicPlayerWidget] });
        } else {
          await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
        }
      } catch (error) {
        console.error('Local play error:', error);
        await interaction.editReply({ content: '❌ Failed to play local music. Make sure the file exists and is accessible.', ephemeral: true });
      }
      return;
    }

    // Local pause command
    if (commandName === 'localpause') {
      const player = localMusicPlayers.get(interaction.guild.id);
      if (!player || !player.getAudioPlayer()) {
        await interaction.reply({ content: '❌ No local music player active!', ephemeral: true });
        return;
      }

      const audioPlayer = player.getAudioPlayer();
      
      // Check actual audio player state
      const isCurrentlyPaused = audioPlayer.state.status === AudioPlayerStatus.Paused;
      
      if (isCurrentlyPaused || player.isPaused) {
        audioPlayer.unpause();
        player.isPaused = false;
        player.isPlaying = true;
        await interaction.reply('▶️ **Resumed** local music playback');
      } else if (audioPlayer.state.status === AudioPlayerStatus.Playing) {
        audioPlayer.pause();
        player.isPaused = true;
        // Keep isPlaying true when paused
        await interaction.reply('⏸️ **Paused** local music playback');
      } else {
        await interaction.reply({ content: '❌ No music is currently playing to pause/resume!', ephemeral: true });
      }
      return;
    }

    // Local next command
    if (commandName === 'localnext') {
      const player = localMusicPlayers.get(interaction.guild.id);
      const audioPlayer = player?.getAudioPlayer();
      
      if (!player || !audioPlayer) {
        await interaction.reply({ content: '❌ No local music player active!', ephemeral: true });
        return;
      }

      const result = player.nextTrack();
      if (result.success) {
        try {
          const audioResource = createAudioResource(player.getCurrentTrack().path, {
            metadata: { title: player.getCurrentTrack().name }
          });
          if (audioResource.volume) {
            audioResource.volume.setVolume(player.volume / 100);
          }
          audioPlayer.play(audioResource);
          
          // Ensure continuous playback is maintained
          player.isPlaying = true;
          player.isPaused = false;
          
          // Send immediate feedback with full widget
          await interaction.reply({ embeds: [player.getNowPlayingWidget()] });
        } catch (error) {
          console.error('Error playing next track:', error);
          await interaction.reply({ content: '❌ Failed to play next track.', ephemeral: true });
        }
      } else {
        await interaction.reply({ content: `❌ ${result.message}`, ephemeral: true });
      }
      return;
    }

    // Local previous command
    if (commandName === 'localprevious') {
      const player = localMusicPlayers.get(interaction.guild.id);
      const audioPlayer = player?.getAudioPlayer();
      
      if (!player || !audioPlayer) {
        await interaction.reply({ content: '❌ No local music player active!', ephemeral: true });
        return;
      }

      const result = player.previous();
      if (result.success) {
        try {
          const audioResource = createAudioResource(player.getCurrentTrack().path, {
            metadata: { title: player.getCurrentTrack().name }
          });
          if (audioResource.volume) {
            audioResource.volume.setVolume(player.volume / 100);
          }
          audioPlayer.play(audioResource);
          
          // Ensure continuous playback is maintained
          player.isPlaying = true;
          player.isPaused = false;
          
          // Send immediate feedback with full widget
          await interaction.reply({ embeds: [player.getNowPlayingWidget()] });
        } catch (error) {
          console.error('Error playing previous track:', error);
          await interaction.reply({ content: '❌ Failed to play previous track.', ephemeral: true });
        }
      } else {
        await interaction.reply({ content: `❌ ${result.message}`, ephemeral: true });
      }
      return;
    }

    // Local volume command
    if (commandName === 'localvolume') {
      const player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        await interaction.reply({ content: '❌ No local music player active!', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      let result;

      if (subcommand === 'set') {
        const level = interaction.options.getInteger('level');
        result = player.setVolume(level);
      } else if (subcommand === 'up') {
        result = player.volumeUp();
      } else if (subcommand === 'down') {
        result = player.volumeDown();
      }

      // Apply volume to current audio player if playing
      const audioPlayer = player.getAudioPlayer();
      if (audioPlayer && audioPlayer.state.resource && audioPlayer.state.resource.volume) {
        audioPlayer.state.resource.volume.setVolume(player.volume / 100);
      }

      if (result.success) {
        await interaction.reply(`🔊 ${result.message}`);
      } else {
        await interaction.reply({ content: `❌ ${result.message}`, ephemeral: true });
      }
      return;
    }

    // Local loop command
    if (commandName === 'localloop') {
      const player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        await interaction.reply({ content: '❌ No local music player active!', ephemeral: true });
        return;
      }

      const result = player.toggleLoop();
      await interaction.reply(`🔁 ${result.message}`);
      return;
    }

    // Local shuffle command
    if (commandName === 'localshuffle') {
      const player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        await interaction.reply({ content: '❌ No local music player active!', ephemeral: true });
        return;
      }

      const result = player.toggleShuffle();
      await interaction.reply(`🔀 ${result.message}`);
      return;
    }

    // Local now playing command
    if (commandName === 'localnowplaying') {
      const player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        await interaction.reply({ content: '❌ No local music player active!', ephemeral: true });
        return;
      }

      await interaction.reply({ embeds: [player.getNowPlayingWidget()] });
      return;
    }

    // Local playlist command
    if (commandName === 'localplaylist') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      const page = interaction.options.getInteger('page') || 1;
      await interaction.reply({ embeds: [player.getPlaylistEmbed(page)] });
      return;
    }

    // Local stats command
    if (commandName === 'localstats') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      await interaction.reply({ embeds: [player.getPlayerStats()] });
      return;
    }

    // Enhanced playlist selection command with advanced search options
    if (commandName === 'localplaylist-play') {
      const member = interaction.member;
      const voiceChannel = member.voice.channel;

      if (!voiceChannel) {
        await interaction.reply({
          content: '❌ You need to be in a voice channel to play music!',
          ephemeral: true
        });
        return;
      }

      const playlistType = interaction.options.getString('playlist');
      const customPlaylistName = interaction.options.getString('custom_playlist');
      const enableShuffle = interaction.options.getBoolean('shuffle') || false;
      const enableLoop = interaction.options.getBoolean('loop') || false;

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      await interaction.deferReply();

      try {
        // Set player modes before loading playlist
        if (enableShuffle) player.shuffle = true;
        if (enableLoop) player.loop = true;

        let playlist;
        let playlistDisplayName;

        // Handle custom playlist selection with enhanced search
        if (playlistType === 'custom') {
          if (!customPlaylistName) {
            // Show available custom playlists with enhanced interactive interface
            const customPlaylists = player.getCustomPlaylistsList();
            if (customPlaylists.length === 0) {
              const helpEmbed = new EmbedBuilder()
                .setColor(0xFF6B35)
                .setTitle('📝 No Custom Playlists Found')
                .setDescription('Create your first custom playlist to get started!')
                .addFields(
                  { name: '🎮 Quick Start Guide', value: '1. Use `/localplay` to browse your music\n2. Use `/pladd playlist:MyPlaylist` to add current track\n3. Use `/localplaylist-play playlist:custom custom_playlist:MyPlaylist` to play\n4. Or use `/pplay playlist:MyPlaylist` for quick access', inline: false },
                  { name: '🔍 Search Features', value: '• Search by keywords: `/pladd playlist:Favorites search:love`\n• Add specific tracks: `/pladd playlist:Rock track:5`\n• Add multiple tracks: `/paddmulti playlist:Mix tracks:1,3,5,7`', inline: false },
                  { name: '📊 Your Music Library', value: `${player.playlist.length} tracks available`, inline: true }
                )
                .setFooter({ text: 'Enhanced Custom Playlist System • Smart Search & Organization' })
                .setTimestamp();

              await interaction.editReply({ embeds: [helpEmbed] });
              return;
            }

            // Enhanced playlist display with search and filter options
            const playlistList = customPlaylists.slice(0, 8).map((pl, index) => {
              const createdDate = pl.createdAt ? new Date(pl.createdAt).toLocaleDateString() : 'Unknown';
              return `**${index + 1}. ${pl.name}** • ${pl.trackCount} tracks • Created: ${createdDate}`;
            }).join('\n');

            const embed = new EmbedBuilder()
              .setColor(0x1DB954)
              .setTitle('🎵 Custom Playlist Selector')
              .setDescription(`**Your Custom Playlists:**\n\n${playlistList}\n\n**🔍 Search Options:**\n• **Quick Play:** Use buttons below for instant playback\n• **Advanced:** \`/localplaylist-play playlist:custom custom_playlist:NAME\`\n• **Smart Search:** Filter by genre, mood, or keywords`)
              .addFields(
                { name: '📊 Statistics', value: `${customPlaylists.length} playlists • ${customPlaylists.reduce((sum, pl) => sum + pl.trackCount, 0)} total tracks`, inline: true },
                { name: '🎮 Quick Commands', value: '• `/pplay playlist:NAME` - Instant play\n• `/pladd playlist:NAME` - Add tracks\n• `/plist` - Manage playlists', inline: true },
                { name: '🔍 Advanced Features', value: '• Shuffle & Loop modes\n• Search by keywords\n• Smart recommendations', inline: true }
              )
              .setFooter({ text: 'Enhanced Custom Playlist Manager • Click buttons for instant playback' })
              .setTimestamp();

            // Enhanced playlist buttons with more options
            const playlistButtons = new ActionRowBuilder();
            const maxButtons = Math.min(customPlaylists.length, 5);
            
            for (let i = 0; i < maxButtons; i++) {
              const playlist = customPlaylists[i];
              let buttonLabel = playlist.name;
              if (buttonLabel.length > 15) {
                buttonLabel = buttonLabel.substring(0, 12) + '...';
              }
              
              playlistButtons.addComponents(
                new ButtonBuilder()
                  .setCustomId(`play_custom_playlist_${playlist.name}`)
                  .setLabel(`🎵 ${buttonLabel}`)
                  .setStyle(ButtonStyle.Primary)
              );
            }

            // Additional control buttons
            const controlButtons = new ActionRowBuilder()
              .addComponents(
                new ButtonBuilder()
                  .setCustomId('playlist_search_by_genre')
                  .setLabel('🎭 Browse by Genre')
                  .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                  .setCustomId('playlist_search_by_mood')
                  .setLabel('😊 Browse by Mood')
                  .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                  .setCustomId('playlist_shuffle_all')
                  .setLabel('🔀 Shuffle All')
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId('playlist_create_new')
                  .setLabel('➕ Create New')
                  .setStyle(ButtonStyle.Success)
              );

            const components = [playlistButtons];
            if (customPlaylists.length > 0) {
              components.push(controlButtons);
            }

            await interaction.editReply({ embeds: [embed], components });
            return;
          }

          // Load specific custom playlist with validation
          playlist = player.loadCustomPlaylistByName(customPlaylistName);
          playlistDisplayName = `📝 Custom: ${customPlaylistName}`;
          
          if (playlist.length === 0) {
            const errorEmbed = new EmbedBuilder()
              .setColor(0xFF6B35)
              .setTitle(`❌ Playlist "${customPlaylistName}" Not Found`)
              .setDescription('The requested custom playlist is empty or doesn\'t exist.')
              .addFields(
                { name: '🔍 Available Playlists', value: customPlaylists.length > 0 ? customPlaylists.map(pl => `• **${pl.name}** (${pl.trackCount} tracks)`).join('\n') : 'No playlists found', inline: false },
                { name: '➕ Create This Playlist', value: `Use \`/pladd playlist:${customPlaylistName}\` to create it and add tracks`, inline: false },
                { name: '🎮 Quick Actions', value: '• `/plist` - View all playlists\n• `/localplay` - Browse music library\n• `/pladd` - Create new playlist', inline: false }
              )
              .setFooter({ text: 'Custom Playlist Manager • Smart Search System' })
              .setTimestamp();

            await interaction.editReply({ embeds: [errorEmbed] });
            return;
          }
        } else {
          // Load predefined playlist with enhanced categorization
          playlist = player.loadPlaylist(null, playlistType);
          
          const playlistNames = {
            'all': '🎵 Complete Music Library',
            'tamil': '🎭 Tamil Songs Collection',
            'english': '🎤 English Songs Collection', 
            'rock': '🎸 Rock & Pop Hits',
            'movies': '🎬 Movie Soundtracks',
            'favorites_ak': '⭐ Favorites (A-K)',
            'favorites_lz': '⭐ Favorites (L-Z)',
            'shuffle': '🔀 Shuffled Complete Library'
          };
          
          playlistDisplayName = playlistNames[playlistType] || playlistType;
        }
        
        if (playlist.length === 0) {
          const noTracksEmbed = new EmbedBuilder()
            .setColor(0xFF6B35)
            .setTitle(`❌ No Tracks in "${playlistDisplayName}"`)
            .setDescription('The selected playlist is empty or no matching tracks were found.')
            .addFields(
              { name: '📁 Check Your Music', value: 'Make sure you have music files in these folders:\n• `./music/`\n• `./songs/`\n• `./audio/`', inline: false },
              { name: '🎵 Supported Formats', value: 'MP3, WAV, OGG, M4A, FLAC', inline: true },
              { name: '📊 Total Library', value: `${player.playlist.length} tracks detected`, inline: true },
              { name: '🔄 Try Different Playlist', value: 'Use `/localplaylist-play` with different options', inline: false }
            )
            .setFooter({ text: 'Enhanced Music System • Check file formats and locations' })
            .setTimestamp();

          await interaction.editReply({ embeds: [noTracksEmbed] });
          return;
        }

        // Join voice channel with enhanced connection handling
        let connection = voiceConnections.get(interaction.guild.id);
        if (!connection) {
          connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
          });
          voiceConnections.set(interaction.guild.id, connection);

          connection.on(VoiceConnectionStatus.Ready, () => {
            console.log('🎵 Enhanced voice connection ready for playlist playback!');
          });

          connection.on(VoiceConnectionStatus.Disconnected, () => {
            console.log('🎵 Voice connection disconnected');
            voiceConnections.delete(interaction.guild.id);
          });

          connection.on('error', (error) => {
            console.error('🎵 Voice connection error:', error);
          });
        }

        // Enhanced playback initialization
        player.setVoiceConnection(connection);
        const result = player.play(0);
        
        if (result.success) {
          // Create audio resource with enhanced settings
          const audioResource = createAudioResource(player.getCurrentTrack().path, {
            metadata: {
              title: player.getCurrentTrack().name,
              artist: 'Local Library',
              album: playlistDisplayName
            },
            inlineVolume: true
          });

          // Create and configure audio player
          const audioPlayer = createAudioPlayer();
          if (audioResource.volume) {
            audioResource.volume.setVolume(player.volume / 100);
          }
          
          audioPlayer.play(audioResource);
          connection.subscribe(audioPlayer);
          player.setAudioPlayer(audioPlayer);

          // Enhanced continuous playback event handlers
          audioPlayer.on(AudioPlayerStatus.Playing, () => {
            console.log(`🎵 Enhanced playlist playing: ${player.getCurrentTrack().name}`);
            player.isPlaying = true;
            player.isPaused = false;
          });

          audioPlayer.on(AudioPlayerStatus.Idle, async () => {
            console.log('🎵 Enhanced playlist track finished, auto-continuing...');
            
            if (player.loop && player.getCurrentTrack()) {
              // Loop current track
              try {
                const loopResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name },
                  inlineVolume: true
                });
                if (loopResource.volume) {
                  loopResource.volume.setVolume(player.volume / 100);
                }
                audioPlayer.play(loopResource);
                player.isPlaying = true;
                player.isPaused = false;
              } catch (error) {
                console.error('Error looping track in enhanced playlist:', error);
                player.isPlaying = false;
              }
            } else if (player.playlist.length > 1 && player.currentIndex < player.playlist.length - 1) {
              // Auto-play next track
              const nextResult = player.nextTrack();
              if (nextResult.success) {
                try {
                  const nextResource = createAudioResource(player.getCurrentTrack().path, {
                    metadata: { title: player.getCurrentTrack().name },
                    inlineVolume: true
                  });
                  if (nextResource.volume) {
                    nextResource.volume.setVolume(player.volume / 100);
                  }
                  audioPlayer.play(nextResource);
                  player.isPlaying = true;
                  player.isPaused = false;
                  console.log(`⏭️ Enhanced playlist auto-next: ${player.getCurrentTrack().name}`);
                } catch (error) {
                  console.error('Error playing next track in enhanced playlist:', error);
                  player.isPlaying = false;
                }
              }
            } else if (player.playlist.length > 1) {
              // Restart playlist from beginning for continuous playback
              player.currentIndex = 0;
              player.currentTrack = player.playlist[0];
              
              try {
                const restartResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name },
                  inlineVolume: true
                });
                if (restartResource.volume) {
                  restartResource.volume.setVolume(player.volume / 100);
                }
                audioPlayer.play(restartResource);
                player.isPlaying = true;
                player.isPaused = false;
                console.log(`🔄 Enhanced playlist restarted: ${player.getCurrentTrack().name}`);
              } catch (error) {
                console.error('Error restarting enhanced playlist:', error);
                player.isPlaying = false;
              }
            } else {
              player.isPlaying = false;
            }
          });

          audioPlayer.on('error', (error) => {
            console.error('Enhanced playlist audio player error:', error);
            player.isPlaying = false;
            player.isPaused = false;
          });

          // Enhanced success embed with more information
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 Enhanced Playlist Started')
            .setDescription(`**${playlistDisplayName}**\n\n🎵 **Now Playing:** ${player.getCurrentTrack().name}`)
            .addFields(
              { name: '📊 Playlist Info', value: `${playlist.length} tracks total`, inline: true },
              { name: '🔊 Audio Quality', value: `Volume: ${player.volume}%\nFormat: ${player.getCurrentTrack().extension.toUpperCase()}`, inline: true },
              { name: '🎤 Voice Channel', value: voiceChannel.name, inline: true },
              { name: '🔁 Playback Modes', value: `Loop: ${player.loop ? '✅ Enabled' : '❌ Disabled'}\nShuffle: ${player.shuffle ? '✅ Enabled' : '❌ Disabled'}`, inline: true },
              { name: '📍 Progress', value: `Track 1 of ${playlist.length}\nPosition: 00:00 / ${player.getCurrentTrack().duration}`, inline: true },
              { name: '🎮 Available Controls', value: '`/localpause` • `/localnext` • `/localprevious`\n`/localvolume` • `/localloop` • `/localshuffle`', inline: true },
              { name: '🔍 Search Features', value: '• `/localplay search:keywords` - Find specific songs\n• `/localcompactwidget` - Quick track selector\n• `/localplaylist` - View full playlist details', inline: false }
            )
            .setFooter({ text: `${playlistDisplayName} • Enhanced Music System with Smart Controls` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });

        } else {
          await interaction.editReply({ 
            content: `❌ **Playback Failed**\n\n${result.message}\n\n**Troubleshooting:**\n• Check if music files exist\n• Verify file permissions\n• Try a different playlist`, 
            ephemeral: true 
          });
        }
      } catch (error) {
        console.error('Enhanced playlist selection error:', error);
        
        const errorEmbed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('❌ Playlist Error')
          .setDescription('An unexpected error occurred while starting the playlist.')
          .addFields(
            { name: '🔍 Possible Causes', value: '• Music files may be corrupted\n• Insufficient permissions\n• Network connectivity issues\n• Voice channel restrictions', inline: false },
            { name: '🛠️ Solutions', value: '• Try a different playlist\n• Check your music files\n• Rejoin the voice channel\n• Contact support if issue persists', inline: false },
            { name: '📞 Support', value: 'Use `/help` for more assistance', inline: true }
          )
          .setFooter({ text: 'Enhanced Error Handling • Technical Support Available' })
          .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
      }
      return;
    }

    // Uptime command
    if (commandName === 'uptime') {
      if (uptimeMonitor) {
        await interaction.reply({ embeds: [uptimeMonitor.getUptimeEmbed()] });
      } else {
        await interaction.reply({ content: '❌ Uptime monitoring is not active.', ephemeral: true });
      }
      return;
    }

    // Local widget command
    if (commandName === 'localwidget') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      await interaction.reply({ embeds: [player.getNowPlayingWidget()] });
      return;
    }

    // Local custom widget command
    if (commandName === 'localcustomwidget') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      const widget = player.getCustomPlaylistWidget();
      await interaction.reply({ embeds: widget.embeds, components: widget.components });
      return;
    }

    // Local add to playlist command
    if (commandName === 'pladd') {
      const playlistName = interaction.options.getString('playlist');
      const searchTerm = interaction.options.getString('search');
      const trackNumber = interaction.options.getInteger('track');

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      await interaction.deferReply();

      try {
        let result;
        
        if (trackNumber !== null) {
          // Add specific track by number
          result = player.addToCustomPlaylist(playlistName, null, trackNumber - 1);
        } else if (searchTerm) {
          // Add tracks matching search term
          result = player.addToCustomPlaylist(playlistName, searchTerm);
        } else {
          // Add currently playing track
          result = player.addCurrentToPlaylist(playlistName);
        }

        if (result.success) {
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 Track Added to Playlist')
            .setDescription(`**${result.message}**`)
            .addFields(
              { name: '📝 Playlist', value: playlistName, inline: true },
              { name: '➕ Tracks Added', value: result.tracksAdded.toString(), inline: true },
              { name: '📊 Total in Playlist', value: result.totalInPlaylist.toString(), inline: true }
            );

          if (result.addedTracks && result.addedTracks.length > 0) {
            const trackList = result.addedTracks.slice(0, 5).map(track => `• ${track.name}`).join('\n');
            const extraTracks = result.addedTracks.length > 5 ? `\n... and ${result.addedTracks.length - 5} more` : '';
            embed.addFields({ name: '🎵 Added Tracks', value: trackList + extraTracks, inline: false });
          }

          embed.addFields(
            { name: '🎮 Playlist Commands', value: '• `/localplaylist-play` - Play this playlist\n• `/localaddtoplaylist` - Add more tracks\n• View custom playlists with `/localstats`', inline: false }
          );

          embed.setFooter({ text: `Custom Playlist: ${playlistName}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
        }
      } catch (error) {
        console.error('Local add to playlist error:', error);
        await interaction.editReply({ content: '❌ Failed to add track to playlist.', ephemeral: true });
      }
      return;
    }

    // Local add multiple tracks command
    if (commandName === 'paddmulti') {
      const playlistName = interaction.options.getString('playlist');
      const tracksInput = interaction.options.getString('tracks');
      const showList = interaction.options.getBoolean('show_list') || false;

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      await interaction.deferReply();

      try {
        // Show track list if requested
        if (showList) {
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 Track List for Selection')
            .setDescription(`**Available tracks in your library:**\n\nUse the track numbers in the format: \`1,3,5,7\``)
            .setFooter({ text: `Total tracks: ${player.playlist.length}` })
            .setTimestamp();

          const trackList = player.playlist.slice(0, 20).map((track, index) => 
            `**${index + 1}.** ${track.name}`
          ).join('\n');
          
          const extraTracks = player.playlist.length > 20 ? `\n... and ${player.playlist.length - 20} more tracks` : '';
          embed.addFields({ name: 'Tracks', value: trackList + extraTracks, inline: false });

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        // Parse track numbers
        const trackNumbers = tracksInput.split(',').map(num => parseInt(num.trim())).filter(num => !isNaN(num));
        
        if (trackNumbers.length === 0) {
          await interaction.editReply({ content: '❌ No valid track numbers provided! Use format: `1,3,5,7`', ephemeral: true });
          return;
        }

        // Convert to indices (subtract 1)
        const trackIndices = trackNumbers.map(num => num - 1);
        
        const result = player.addMultipleTracksToPlaylist(playlistName, trackIndices);

        if (result.success) {
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 Multiple Tracks Added to Playlist')
            .setDescription(`**${result.message}**`)
            .addFields(
              { name: '📝 Playlist', value: playlistName, inline: true },
              { name: '➕ Tracks Added', value: result.tracksAdded.toString(), inline: true },
              { name: '📊 Total in Playlist', value: result.totalInPlaylist.toString(), inline: true },
              { name: '🎯 Track Numbers', value: trackNumbers.join(', '), inline: false }
            );

          if (result.addedTracks && result.addedTracks.length > 0) {
            const trackList = result.addedTracks.slice(0, 8).map(track => `• ${track.name}`).join('\n');
            const extraTracks = result.addedTracks.length > 8 ? `\n... and ${result.addedTracks.length - 8} more` : '';
            embed.addFields({ name: '🎵 Added Tracks', value: trackList + extraTracks, inline: false });
          }

          embed.setFooter({ text: `Custom Playlist: ${playlistName}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
        }
      } catch (error) {
        console.error('Local add multiple tracks error:', error);
        await interaction.editReply({ content: '❌ Failed to add tracks to playlist.', ephemeral: true });
      }
      return;
    }

    // Local add all tracks command
    if (commandName === 'paddall') {
      const playlistName = interaction.options.getString('playlist');
      const confirm = interaction.options.getBoolean('confirm');

      if (!confirm) {
        await interaction.reply({ content: '❌ You must confirm to add all tracks to the playlist!', ephemeral: true });
        return;
      }

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      await interaction.deferReply();

      try {
        const result = player.addAllTracksToPlaylist(playlistName);

        if (result.success) {
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 All Tracks Added to Playlist')
            .setDescription(`**${result.message}**`)
            .addFields(
              { name: '📝 Playlist', value: playlistName, inline: true },
              { name: '➕ Tracks Added', value: result.tracksAdded.toString(), inline: true },
              { name: '📊 Total in Playlist', value: result.totalInPlaylist.toString(), inline: true },
              { name: '📚 Library Size', value: `${player.playlist.length} tracks`, inline: true }
            );

          embed.addFields(
            { name: '🎮 Next Steps', value: '• `/localcustomplay playlist:' + playlistName + '` - Play this playlist\n• `/localcustomlist` - View all custom playlists\n• `/localstats` - View detailed statistics', inline: false }
          );

          embed.setFooter({ text: `Custom Playlist: ${playlistName} • All tracks added` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
        }
      } catch (error) {
        console.error('Local add all tracks error:', error);
        await interaction.editReply({ content: '❌ Failed to add all tracks to playlist.', ephemeral: true });
      }
      return;
    }

    // Local rename playlist command
    if (commandName === 'prename') {
      const oldName = interaction.options.getString('old_name');
      const newName = interaction.options.getString('new_name');

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      await interaction.deferReply();

      try {
        const result = player.renamePlaylist(oldName, newName);

        if (result.success) {
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('✅ Playlist Renamed Successfully')
            .setDescription(`**${result.message}**`)
            .addFields(
              { name: '📝 Old Name', value: result.oldName, inline: true },
              { name: '🆕 New Name', value: result.newName, inline: true },
              { name: '🎵 Track Count', value: result.trackCount.toString(), inline: true }
            );

          embed.addFields(
            { name: '🎮 Updated Commands', value: `• \`/localcustomplay playlist:${result.newName}\` - Play renamed playlist\n• \`/localaddtoplaylist playlist:${result.newName}\` - Add tracks to renamed playlist\n• \`/localcustomlist\` - View all custom playlists`, inline: false }
          );

          embed.setFooter({ text: `Playlist renamed successfully` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
        }
      } catch (error) {
        console.error('Local rename playlist error:', error);
        await interaction.editReply({ content: '❌ Failed to rename playlist.', ephemeral: true });
      }
      return;
    }

    // Enhanced local custom playlist play command with search
    if (commandName === 'pplay') {
      const member = interaction.member;
      const voiceChannel = member.voice.channel;

      if (!voiceChannel) {
        await interaction.reply({
          content: '❌ You need to be in a voice channel to play music!',
          ephemeral: true
        });
        return;
      }

      const playlistName = interaction.options.getString('playlist');
      const searchQuery = interaction.options.getString('search');
      const enableShuffle = interaction.options.getBoolean('shuffle') || false;
      const enableLoop = interaction.options.getBoolean('loop') || false;

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      await interaction.deferReply();

      try {
        // Set player modes before loading playlist
        if (enableShuffle) player.shuffle = true;
        if (enableLoop) player.loop = true;

        // Load specific custom playlist with optional search
        let playlist;
        if (searchQuery) {
          // Search within the playlist
          const fullPlaylist = player.loadCustomPlaylistByName(playlistName);
          playlist = fullPlaylist.filter(track => 
            track.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            track.filename.toLowerCase().includes(searchQuery.toLowerCase())
          );
          
          if (playlist.length === 0) {
            await interaction.editReply({
              content: `❌ No tracks found matching "${searchQuery}" in playlist "${playlistName}"!\n\nTry a different search term or check the playlist contents.`,
              ephemeral: true
            });
            return;
          }
        } else {
          playlist = player.loadCustomPlaylistByName(playlistName);
        }
        
        if (playlist.length === 0) {
          const availablePlaylists = player.getCustomPlaylistsList();
          const playlistList = availablePlaylists.length > 0 
            ? availablePlaylists.map(pl => `• **${pl.name}** (${pl.trackCount} tracks)`).join('\n')
            : 'No custom playlists found.';

          await interaction.editReply({
            content: `❌ Custom playlist "${playlistName}" not found or is empty!\n\n**Available Custom Playlists:**\n${playlistList}\n\nUse \`/pladd playlist:${playlistName}\` to create it or add tracks.`,
            ephemeral: true
          });
          return;
        }

        // Join voice channel
        let connection = voiceConnections.get(interaction.guild.id);
        if (!connection) {
          connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
          });
          voiceConnections.set(interaction.guild.id, connection);

          connection.on(VoiceConnectionStatus.Ready, () => {
            console.log('Voice connection ready for custom playlist playback!');
          });

          connection.on(VoiceConnectionStatus.Disconnected, () => {
            console.log('Voice connection disconnected');
            voiceConnections.delete(interaction.guild.id);
          });
        }

        // Start playing first track
        const result = player.play(0);
        
        if (result.success) {
          // Create audio resource from local file
          const audioResource = createAudioResource(player.getCurrentTrack().path, {
            metadata: {
              title: player.getCurrentTrack().name
            }
          });

          // Create and configure audio player
          const audioPlayer = createAudioPlayer();
          audioPlayer.play(audioResource);
          connection.subscribe(audioPlayer);

          // Set volume
          if (audioResource.volume) {
            audioResource.volume.setVolume(player.volume / 100);
          }

          // Enhanced continuous playback event handlers for custom playlists
          audioPlayer.on(AudioPlayerStatus.Playing, async () => {
            console.log(`🎵 Now playing from custom playlist "${playlistName}": ${player.getCurrentTrack().name}`);
            player.isPlaying = true;
            player.isPaused = false;
            
            // Send enhanced "Now Playing" notification for custom playlist
            try {
              const customPlayingEmbed = new EmbedBuilder()
                .setColor(0x1DB954)
                .setTitle('🎵 Custom Playlist Playing')
                .setDescription(`**${player.getCurrentTrack().name}**`)
                .addFields(
                  { name: '📝 Playlist', value: playlistName, inline: true },
                  { name: '📍 Position', value: `${player.currentIndex + 1}/${player.playlist.length}`, inline: true },
                  { name: '🎤 Voice Channel', value: voiceChannel.name, inline: true },
                  { name: '🔧 Format', value: player.getCurrentTrack().extension.toUpperCase(), inline: true },
                  { name: '💾 File Size', value: `${(player.getCurrentTrack().size / 1024 / 1024).toFixed(2)} MB`, inline: true },
                  { name: '🔊 Volume', value: `${player.volume}%`, inline: true }
                )
                .setFooter({ text: `Custom Playlist: ${playlistName} • Continuous playback enabled` })
                .setTimestamp();
              
              await interaction.followUp({ embeds: [customPlayingEmbed] });
            } catch (error) {
              console.error('Error sending custom playlist now playing notification:', error);
            }
          });

          audioPlayer.on(AudioPlayerStatus.Idle, async () => {
            console.log('🎵 Custom playlist track finished, auto-continuing...');
            
            if (player.loop && player.getCurrentTrack()) {
              // Loop current track
              try {
                console.log('🔁 Looping current track in custom playlist:', player.getCurrentTrack().name);
                const loopResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name },
                  inlineVolume: true
                });
                if (loopResource.volume) {
                  loopResource.volume.setVolume(player.volume / 100);
                }
                audioPlayer.play(loopResource);
                player.isPlaying = true;
                player.isPaused = false;
                
                // Send loop notification
                try {
                  const loopEmbed = new EmbedBuilder()
                    .setColor(0x1DB954)
                    .setTitle('🔁 Track Looping')
                    .setDescription(`**${player.getCurrentTrack().name}** is now looping`)
                    .addFields(
                      { name: '📝 Playlist', value: playlistName, inline: true },
                      { name: '🔁 Mode', value: 'Single Track Loop', inline: true }
                    )
                    .setTimestamp();
                  await interaction.followUp({ embeds: [loopEmbed] });
                } catch (error) {
                  console.error('Error sending loop notification:', error);
                }
              } catch (error) {
                console.error('Error looping track in custom playlist:', error);
                player.isPlaying = false;
              }
            } else if (player.playlist.length > 1 && player.currentIndex < player.playlist.length - 1) {
              // Auto-play next track in custom playlist
              const nextResult = player.nextTrack();
              if (nextResult.success) {
                try {
                  console.log(`⏭️ Custom playlist auto-next: ${player.getCurrentTrack().name}`);
                  const nextResource = createAudioResource(player.getCurrentTrack().path, {
                    metadata: { title: player.getCurrentTrack().name },
                    inlineVolume: true
                  });
                  if (nextResource.volume) {
                    nextResource.volume.setVolume(player.volume / 100);
                  }
                  audioPlayer.play(nextResource);
                  player.isPlaying = true;
                  player.isPaused = false;
                  
                  // Send auto-next notification
                  try {
                    const autoNextEmbed = new EmbedBuilder()
                      .setColor(0x1DB954)
                      .setTitle('⏭️ Auto-Playing Next Track')
                      .setDescription(`**${player.getCurrentTrack().name}**`)
                      .addFields(
                        { name: '📝 Playlist', value: playlistName, inline: true },
                        { name: '📍 Position', value: `${player.currentIndex + 1}/${player.playlist.length}`, inline: true },
                        { name: '⏱️ Duration', value: player.getCurrentTrack().duration, inline: true }
                      )
                      .setTimestamp();
                    await interaction.followUp({ embeds: [autoNextEmbed] });
                  } catch (error) {
                    console.error('Error sending auto-next notification:', error);
                  }
                } catch (error) {
                  console.error('Error playing next track in custom playlist:', error);
                  player.isPlaying = false;
                }
              } else {
                // End of playlist reached
                player.isPlaying = false;
              }
            } else if (player.playlist.length > 1) {
              // Restart custom playlist from beginning for continuous playback
              console.log('🔄 Custom playlist restarting from beginning for continuous playback');
              player.currentIndex = 0;
              player.currentTrack = player.playlist[0];
              
              try {
                const restartResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name },
                  inlineVolume: true
                });
                if (restartResource.volume) {
                  restartResource.volume.setVolume(player.volume / 100);
                }
                audioPlayer.play(restartResource);
                player.isPlaying = true;
                player.isPaused = false;
                console.log(`🔄 Custom playlist restarted: ${player.getCurrentTrack().name}`);
                
                // Send restart notification
                try {
                  const restartEmbed = new EmbedBuilder()
                    .setColor(0x1DB954)
                    .setTitle('🔄 Playlist Restarted')
                    .setDescription(`**${player.getCurrentTrack().name}**\n\nRestarting from the beginning for continuous playback`)
                    .addFields(
                      { name: '📝 Playlist', value: playlistName, inline: true },
                      { name: '📍 Position', value: `1/${player.playlist.length}`, inline: true },
                      { name: '🔄 Auto-Loop', value: 'Continuous playback enabled', inline: true }
                    )
                    .setTimestamp();
                  await interaction.followUp({ embeds: [restartEmbed] });
                } catch (error) {
                  console.error('Error sending restart notification:', error);
                }
              } catch (error) {
                console.error('Error restarting custom playlist:', error);
                player.isPlaying = false;
              }
            } else {
              // Single track finished
              console.log('📻 Custom playlist playback finished');
              player.isPlaying = false;
              
              try {
                const endEmbed = new EmbedBuilder()
                  .setColor(0x636363)
                  .setTitle('📻 Custom Playlist Finished')
                  .setDescription(`Playlist "${playlistName}" has finished playing.`)
                  .addFields(
                    { name: '🔄 Restart Playlist', value: `Use \`/pplay playlist:${playlistName}\` to play again`, inline: false },
                    { name: '➕ Add More Tracks', value: `Use \`/pladd playlist:${playlistName}\` to add more songs`, inline: false }
                  )
                  .setTimestamp();
                await interaction.followUp({ embeds: [endEmbed] });
              } catch (error) {
                console.error('Error sending end notification:', error);
              }
            }
          });

          audioPlayer.on(AudioPlayerStatus.Paused, () => {
            console.log('🎵 Custom playlist music paused');
            player.isPaused = true;
          });

          audioPlayer.on('error', (error) => {
            console.error('Custom playlist audio player error:', error);
            player.isPlaying = false;
            player.isPaused = false;
            
            // Send error notification
            try {
              interaction.followUp({ 
                content: `❌ **Playback Error in "${playlistName}"**\n\nAn error occurred during playback. Use \`/pplay playlist:${playlistName}\` to restart the playlist.`,
                ephemeral: true 
              });
            } catch (notificationError) {
              console.error('Error sending playback error notification:', notificationError);
            }
          });

          // Store the audio player
          player.setAudioPlayer(audioPlayer);

          // Show super minimal widget
          const minimalWidget = player.getSuperMinimalPlaylistWidget();
          const searchInfo = searchQuery ? ` | Search: "${searchQuery}" (${playlist.length} found)` : '';
          
          const embed = new EmbedBuilder()
            .setColor(0x000000)
            .setDescription(`**${playlistName}** • ${player.getCurrentTrack().name}${searchInfo}`)
            .setFooter({ text: `${voiceChannel.name} | ${player.volume}% | ${playlist.length} tracks` });

          await interaction.editReply({ embeds: [embed], components: minimalWidget.components });

        } else {
          await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
        }
      } catch (error) {
        console.error('Custom playlist selection error:', error);
        await interaction.editReply({ content: '❌ Failed to start custom playlist. Please check your music files and try again.', ephemeral: true });
      }
      return;
    }

    // Local custom playlist list command
    if (commandName === 'plist') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      const customPlaylists = player.getCustomPlaylistsList();

      if (customPlaylists.length === 0) {
        const embed = new EmbedBuilder()
          .setColor(0x636363)
          .setTitle('📝 Your Custom Playlists')
          .setDescription('You have no custom playlists yet!\n\n**🎮 How to create custom playlists:**\n1. Play any music with `/localplay`\n2. Use `/localaddtoplaylist playlist:MyPlaylist` to add current track\n3. Or use `/localaddtoplaylist playlist:MyPlaylist search:song_name` to add specific songs\n4. Then play them with `/localcustomplay playlist:MyPlaylist`')
          .addFields(
            { name: '🎵 Available Music', value: `${player.playlist.length} tracks in your library`, inline: true },
            { name: '📁 Quick Commands', value: '• `/localplay` - Browse all music\n• `/localaddtoplaylist` - Create playlists\n• `/localstats` - View statistics', inline: false }
          )
          .setFooter({ text: 'Custom Playlist Manager • Start creating your playlists!' })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        return;
      }

      const playlistList = customPlaylists.slice(0, 15).map((playlist, index) => {
        const createdDate = playlist.createdAt ? new Date(playlist.createdAt).toLocaleDateString() : 'Unknown';
        return `${index + 1}. **${playlist.name}** (${playlist.trackCount} tracks)\n   📅 Created: ${createdDate}\n   🎵 \`/localcustomplay playlist:${playlist.name}\` - Play this playlist`;
      }).join('\n\n');

      const totalTracks = customPlaylists.reduce((sum, pl) => sum + pl.trackCount, 0);

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('📝 Your Custom Playlists')
        .setDescription(`${playlistList}\n\n**🎮 Playlist Commands:**\n🎵 \`/localcustomplay playlist:NAME\` - Play specific playlist\n➕ \`/localaddtoplaylist playlist:NAME\` - Add tracks to playlist\n📊 \`/localstats\` - View detailed statistics`)
        .addFields(
          { name: '📊 Total Custom Playlists', value: customPlaylists.length.toString(), inline: true },
          { name: '🎵 Total Custom Tracks', value: totalTracks.toString(), inline: true },
          { name: '📚 Library Tracks', value: player.playlist.length.toString(), inline: true }
        )
        .setFooter({ text: 'Custom Playlist Manager • Use the commands above to manage your playlists' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // Enhanced custom local now playing command
    if (commandName === 'pnow') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      const widget = player.getCustomLocalNowPlayingWidget();
      await interaction.reply({ embeds: widget.embeds, components: widget.components });
      return;
    }

    // Compact widget with track selection command
    if (commandName === 'localcompactwidget') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      const widget = player.getCompactWidgetWithTrackSelection();
      await interaction.reply({ 
        content: '🎵 **Compact Music Player with Track Selection**\n\n**Features:**\n• 🎮 Essential playback controls\n• 🎵 Quick track selection buttons\n• 📱 Compact design for mobile\n• ⚡ Instant song switching\n\n**Usage:** Click any track button below to instantly switch to that song!',
        embeds: widget.embeds, 
        components: widget.components 
      });
      return;
    }

    // Minimal widget with track selection command
    if (commandName === 'localminimalwidget') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
        player.loadPlaylist();
      }

      const widget = player.getSuperMinimalPlaylistWidget();
      await interaction.reply({ 
        content: '🎵 **Super Minimal Widget with Track Selection**\n\n**Features:**\n• ⚡ Ultra-compact design\n• 🎮 Essential controls only\n• 🎵 Quick track switching (3 at a time)\n• ⬅️➡️ Page through tracks\n\n**Usage:** Select tracks instantly with the buttons below!',
        embeds: widget.embeds, 
        components: widget.components 
      });
      return;
    }

    // Fix playlist command
    if (commandName === 'pfix') {
      const playlistName = interaction.options.getString('playlist');
      const addAllMusic = interaction.options.getBoolean('add_all_music') || false;

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      await interaction.deferReply();

      try {
        let result;
        
        if (addAllMusic) {
          // Replace playlist with all current music
          result = player.addAllCurrentMusicToPlaylist(playlistName);
        } else {
          // Fix existing playlist
          result = player.fixAndUpdatePlaylist(playlistName);
        }

        if (result.success) {
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('✅ Playlist Fixed and Updated')
            .setDescription(`**${result.message}**`)
            .addFields(
              { name: '📝 Playlist', value: playlistName, inline: true },
              { name: '🎵 Total Tracks', value: result.totalTracks?.toString() || result.totalInPlaylist?.toString() || '0', inline: true },
              { name: '🔧 Action', value: addAllMusic ? 'Replaced with all music' : 'Fixed existing tracks', inline: true }
            );

          if (result.fixedCount !== undefined) {
            embed.addFields(
              { name: '✅ Fixed Tracks', value: result.fixedCount.toString(), inline: true },
              { name: '❌ Removed Invalid', value: result.removedCount.toString(), inline: true }
            );
          }

          embed.addFields(
            { name: '🎮 Next Steps', value: `• \`/localcustomplay playlist:${playlistName}\` - Play this playlist\n• \`/localcustomlist\` - View all playlists\n• \`/localstats\` - View statistics`, inline: false }
          );

          embed.setFooter({ text: `Playlist Manager • ${playlistName} updated successfully` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
        }
      } catch (error) {
        console.error('Fix playlist error:', error);
        await interaction.editReply({ content: '❌ Failed to fix playlist. Please try again.', ephemeral: true });
      }
      return;
    }

    // Icon Upload command
    if (commandName === 'iconupload') {
      const iconType = interaction.options.getString('type');
      const iconFile = interaction.options.getAttachment('icon');
      const category = interaction.options.getString('category') || 'buttons';

      // Get or create music player to access icon manager
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      await interaction.deferReply();

      try {
        const iconManager = player.getIconManager();
        const result = await iconManager.handleFileUpload(iconFile, iconType, category);

        if (result.success) {
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Icon Applied Instantly')
            .setDescription(`**${iconType}** icon changed instantly! All widgets updated.`)
            .addFields(
              { name: 'Type', value: iconType, inline: true },
              { name: 'Size', value: `${(iconFile.size / 1024).toFixed(1)}KB`, inline: true },
              { name: 'Status', value: '🟢 Live', inline: true }
            )
            .setThumbnail(iconFile.url)
            .setFooter({ text: 'Super Minimal Icon System • Touch to change!' })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ 
            content: `❌ Upload failed: ${result.message}`, 
            ephemeral: true 
          });
        }
      } catch (error) {
        console.error('Icon upload error:', error);
        await interaction.editReply({ 
          content: '❌ An error occurred while uploading the icon.', 
          ephemeral: true 
        });
      }
      return;
    }

    // Icon Manager command
    if (commandName === 'iconmanager') {
      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      const iconManager = player.getIconManager();
      const embed = iconManager.getIconManagerEmbed();
      const components = iconManager.getIconManagerButtons();

      await interaction.reply({ embeds: [embed], components });
      return;
    }

    // Icon Remove command
    if (commandName === 'iconremove') {
      const iconType = interaction.options.getString('type');

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      const iconManager = player.getIconManager();
      const result = iconManager.removeCustomIcon(iconType);

      if (result.success) {
        const embed = new EmbedBuilder()
          .setColor(0xFF6B35)
          .setTitle('🗑️ Custom Icon Removed')
          .setDescription(`Custom ${iconType} icon has been removed and reset to default.`)
          .addFields(
            { name: '🎨 Icon Type', value: iconType, inline: true },
            { name: '📊 Status', value: '🔄 Reset to Default', inline: true },
            { name: '✅ Action', value: 'Custom icon removed successfully', inline: true }
          )
          .setFooter({ text: 'Custom Icon Manager • Icon reset to default' })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
      } else {
        await interaction.reply({ 
          content: `❌ ${result.message}`, 
          ephemeral: true 
        });
      }
      return;
    }

    // Icon Gallery command
    if (commandName === 'icongallery') {
      const page = interaction.options.getInteger('page') || 1;

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      const iconManager = player.getIconManager();
      const embed = iconManager.getIconGallery(page);

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // Icon Auto-Update command
    if (commandName === 'iconupdate') {
      const forceRefresh = interaction.options.getBoolean('force') || false;
      const scanNew = interaction.options.getBoolean('scan_new') || false;

      let player = localMusicPlayers.get(interaction.guild.id);
      if (!player) {
        player = new LocalMusicPlayer();
        localMusicPlayers.set(interaction.guild.id, player);
      }

      await interaction.deferReply();

      try {
        const iconManager = player.getIconManager();
        
        // Perform different types of updates based on options
        let updateResults = {
          success: true,
          customIconCount: 0,
          totalFileCount: 0,
          newIconsFound: 0,
          removedIcons: 0
        };

        if (forceRefresh) {
          // Force refresh from filesystem
          updateResults = iconManager.forceRefresh();
        } else if (scanNew) {
          // Scan for new icons and auto-detect
          updateResults = iconManager.scanAndAutoDetectIcons();
        } else {
          // Standard refresh
          updateResults = iconManager.forceRefresh();
        }

        if (updateResults.success) {
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Icons Auto-Updated Successfully')
            .setDescription('Custom icons have been refreshed and updated!')
            .addFields(
              { name: '🎨 Custom Icons Loaded', value: updateResults.customIconCount.toString(), inline: true },
              { name: '📁 Total Files Scanned', value: updateResults.totalFileCount.toString(), inline: true },
              { name: '🔄 Update Type', value: forceRefresh ? 'Force Refresh' : scanNew ? 'Scan New Files' : 'Standard Refresh', inline: true }
            );

          if (updateResults.newIconsFound > 0) {
            embed.addFields({ name: '🆕 New Icons Found', value: updateResults.newIconsFound.toString(), inline: true });
          }

          if (updateResults.removedIcons > 0) {
            embed.addFields({ name: '🗑️ Removed Missing Icons', value: updateResults.removedIcons.toString(), inline: true });
          }

          embed.addFields(
            { name: '🎮 Available Icon Types', value: 'play, pause, next, previous, volumeUp, volumeDown, loop, shuffle, stop, refresh', inline: false },
            { name: '⚡ Auto-Detection', value: 'Files with matching names in icon folders are automatically detected and applied', inline: false },
            { name: '📝 Status', value: '✅ All icons are now up to date and ready for use!', inline: false }
          );

          embed.setFooter({ text: 'Custom Icon Auto-Update • Real-time sync enabled' })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ 
            content: `❌ Auto-update failed: ${updateResults.message || 'Unknown error occurred'}`, 
            ephemeral: true 
          });
        }
      } catch (error) {
        console.error('Icon auto-update error:', error);
        await interaction.editReply({ 
          content: '❌ An error occurred during icon auto-update. Please check the console for details.', 
          ephemeral: true 
        });
      }
      return;
    }

    // Enhanced 24/7 restart command
    if (commandName === 'restart') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        await interaction.reply({ content: '❌ Only the server owner can restart the bot.', ephemeral: true });
        return;
      }

      const reason = interaction.options.getString('reason') || 'Manual restart requested';

      try {
        // Get current uptime and stats
        const currentUptime = Math.round((Date.now() - autoRestartStats.uptimeStart) / 1000 / 60);
        const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        
        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('🚀 24/7 Bot Restart Initiated')
          .setDescription('**Enhanced restart system for continuous operation**')
          .addFields(
            { name: '👮 Initiated by', value: interaction.user.tag, inline: true },
            { name: '📝 Reason', value: reason, inline: true },
            { name: '⏰ Restart Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
            { name: '📊 Current Session', value: `Uptime: ${currentUptime}m\nMemory: ${memoryUsage}MB\nHealth Checks: ${healthCheckCount}`, inline: true },
            { name: '🔄 Auto-Restart Stats', value: `Total Restarts: ${autoRestartStats.totalRestarts}\nLast Reason: ${autoRestartStats.lastRestartReason || 'N/A'}`, inline: true },
            { name: '🌐 24/7 Features', value: '✅ Auto-restart enabled\n✅ Health monitoring active\n✅ Memory management active\n✅ Connection monitoring active', inline: false },
            { name: '🚀 Restart Process', value: '1. Graceful shutdown\n2. Service cleanup\n3. Auto-restart\n4. Service restoration\n5. 24/7 monitoring resumed', inline: false }
          )
          .setFooter({ text: '24/7 Auto-Restart System • Bot will be back online in 10-15 seconds' })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });

        // Log detailed restart information
        console.log(`🚀 24/7 Bot restart initiated by ${interaction.user.tag}: ${reason}`);
        console.log(`📊 Session stats: Uptime ${currentUptime}m, Memory ${memoryUsage}MB, Health checks ${healthCheckCount}`);
        console.log(`🔄 Total restarts: ${autoRestartStats.totalRestarts}, Last reason: ${autoRestartStats.lastRestartReason || 'N/A'}`);

        // Update restart stats
        autoRestartStats.totalRestarts++;
        autoRestartStats.lastRestartTime = Date.now();
        autoRestartStats.lastRestartReason = `Manual restart by ${interaction.user.tag}: ${reason}`;
        saveRestartStats();

        // Perform graceful shutdown
        console.log('🛑 Initiating graceful shutdown...');
        
        // Stop monitoring services
        if (uptimeMonitor) {
          uptimeMonitor.cleanup();
        }
        if (keepAliveService) {
          keepAliveService.stop();
        }

        // Clear intervals and connections
        if (client.vcMoveIntervals) {
          client.vcMoveIntervals.clear();
        }
        localMusicPlayers.clear();
        voiceConnections.clear();

        // Send final status update
        setTimeout(async () => {
          try {
            await interaction.followUp({
              content: '🔄 **Restarting now...** The bot will automatically come back online with 24/7 monitoring active.',
              ephemeral: true
            });
          } catch (followUpError) {
            console.log('⚠️ Could not send follow-up message:', followUpError.message);
          }
          
          console.log('🚀 Executing 24/7 restart...');
          process.exit(0); // Replit will auto-restart
        }, 2000);

        // Emergency restart if normal restart fails
        setTimeout(() => {
          console.log('🚨 Emergency restart - normal restart timeout');
          process.exit(1);
        }, 10000);

      } catch (error) {
        console.error('24/7 Restart command error:', error);
        await interaction.reply({
          content: '❌ Failed to initiate restart. Auto-restart system will handle any issues automatically.',
          ephemeral: true
        });
        
        // Force restart on error
        setTimeout(() => {
          performAutoRestart(`Restart command failure: ${error.message}`);
        }, 3000);
      }
      return;
    }

    // Enhanced Voice Channel Move command with continuous movement
    if (commandName === 'vcmove') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.MoveMembers)) {
        await interaction.reply({ content: '❌ You need the "Move Members" permission to use this command.', ephemeral: true });
        return;
      }

      if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.MoveMembers)) {
        await interaction.reply({ content: '❌ I need the "Move Members" permission to perform this action.', ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user');
      const channel1 = interaction.options.getChannel('channel1');
      const channel2 = interaction.options.getChannel('channel2');
      const allChannels = interaction.options.getBoolean('all_channels') || false;
      const speed = interaction.options.getString('speed');

      const targetMember = interaction.guild.members.cache.get(targetUser.id);

      if (!targetMember) {
        await interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });
        return;
      }

      // Check if user is in a voice channel
      if (!targetMember.voice.channel) {
        await interaction.reply({ 
          content: `❌ User ${targetUser.tag} is not in any voice channel.`, 
          ephemeral: true 
        });
        return;
      }

      // Validate required channels are voice channels
      if (channel1.type !== 2 || (channel2 && channel2.type !== 2)) {
        await interaction.reply({ content: '❌ All specified channels must be voice channels.', ephemeral: true });
        return;
      }

      // Check role hierarchy
      if (targetMember.roles.highest.position >= interaction.member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId) {
        await interaction.reply({ content: '❌ You cannot move someone with equal or higher roles.', ephemeral: true });
        return;
      }

      if (targetMember.roles.highest.position >= interaction.guild.members.me.roles.highest.position) {
        await interaction.reply({ content: '❌ I cannot move someone with equal or higher roles than me.', ephemeral: true });
        return;
      }

      // Set speed delay
      const speedDelays = {
        'ultra': 500,    // 0.5 seconds
        'fast': 1000,    // 1 second
        'medium': 2000,  // 2 seconds
        'slow': 4000     // 4 seconds
      };

      const speedEmojis = {
        'ultra': '🚀',
        'fast': '⚡',
        'medium': '🏃',
        'slow': '🚶'
      };

      const delay = speedDelays[speed];

      // Get channels to move between
      let channelsToMove = [];
      if (allChannels) {
        // Get all voice channels in the server
        channelsToMove = interaction.guild.channels.cache
          .filter(channel => channel.type === 2 && channel.permissionsFor(interaction.guild.members.me).has(PermissionFlagsBits.Connect))
          .map(channel => channel);
      } else if (channel2) {
        // Move between two specific channels
        channelsToMove = [channel1, channel2];
      } else {
        await interaction.reply({ content: '❌ You must specify either a second channel or enable all channels mode.', ephemeral: true });
        return;
      }

      if (channelsToMove.length < 2) {
        await interaction.reply({ content: '❌ Need at least 2 voice channels to move between.', ephemeral: true });
        return;
      }

      // Initialize continuous movement tracking
      if (!client.vcMoveIntervals) {
        client.vcMoveIntervals = new Map();
      }

      // Stop any existing movement for this user
      if (client.vcMoveIntervals.has(targetUser.id)) {
        clearInterval(client.vcMoveIntervals.get(targetUser.id).interval);
        client.vcMoveIntervals.delete(targetUser.id);
      }

      let currentChannelIndex = 0;
      let moveCount = 0;
      const startTime = Date.now();

      try {
        // Send initial confirmation
        const embed = new EmbedBuilder()
          .setColor(0x1DB954)
          .setTitle('🎯 Continuous Voice Channel Movement Started')
          .setDescription(`Moving **${targetUser.tag}** continuously ${allChannels ? 'through all server voice channels' : `between **${channel1.name}** and **${channel2.name}**`}`)
          .addFields(
            { name: '👤 Target User', value: targetUser.tag, inline: true },
            { name: '⚡ Speed', value: `${speedEmojis[speed]} ${speed.toUpperCase()} (${delay}ms)`, inline: true },
            { name: '🔄 Mode', value: allChannels ? `All Channels (${channelsToMove.length})` : 'Two Channels', inline: true },
            { name: '📊 Status', value: '🟢 Active - Moving continuously', inline: true },
            { name: '👮 Started by', value: interaction.user.tag, inline: true },
            { name: '⏹️ Stop Movement', value: 'Restart bot or wait for auto-stop', inline: true }
          )
          .setFooter({ text: 'Continuous VC Mover • Use /vcmovestop to stop movement' })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });

        // Start continuous movement
        const interval = setInterval(async () => {
          try {
            // Check if user is still in the server and in a voice channel
            const currentMember = interaction.guild.members.cache.get(targetUser.id);
            if (!currentMember || !currentMember.voice.channel) {
              // User left voice or server, stop movement
              clearInterval(interval);
              client.vcMoveIntervals.delete(targetUser.id);
              
              const stopEmbed = new EmbedBuilder()
                .setColor(0xFF6B35)
                .setTitle('⏹️ Movement Stopped - User Left Voice')
                .setDescription(`**${targetUser.tag}** left voice chat. Movement stopped automatically.`)
                .addFields(
                  { name: '📊 Total Moves', value: moveCount.toString(), inline: true },
                  { name: '⏱️ Duration', value: `${Math.floor((Date.now() - startTime) / 1000)}s`, inline: true }
                )
                .setTimestamp();
              
              await interaction.followUp({ embeds: [stopEmbed] });
              return;
            }

            // Move to next channel
            const nextChannel = channelsToMove[currentChannelIndex];
            await currentMember.voice.setChannel(nextChannel);
            moveCount++;

            // Update channel index for next move
            currentChannelIndex = (currentChannelIndex + 1) % channelsToMove.length;

            // Send status update every 10 moves
            if (moveCount % 10 === 0) {
              const statusEmbed = new EmbedBuilder()
                .setColor(0x00AE86)
                .setTitle('📊 Movement Status Update')
                .setDescription(`**${targetUser.tag}** continuous movement status`)
                .addFields(
                  { name: '🔄 Total Moves', value: moveCount.toString(), inline: true },
                  { name: '⏱️ Duration', value: `${Math.floor((Date.now() - startTime) / 1000)}s`, inline: true },
                  { name: '📍 Current Channel', value: nextChannel.name, inline: true },
                  { name: '⚡ Speed', value: `${speedEmojis[speed]} ${speed.toUpperCase()}`, inline: true },
                  { name: '📊 Rate', value: `${(moveCount / ((Date.now() - startTime) / 1000)).toFixed(1)} moves/sec`, inline: true },
                  { name: '⏹️ Auto-Stop', value: 'On user disconnect or error', inline: true }
                )
                .setFooter({ text: 'Continuous VC Mover • Active Movement' })
                .setTimestamp();
              
              await interaction.followUp({ embeds: [statusEmbed] });
            }

          } catch (moveError) {
            console.error('Continuous move error:', moveError);
            // Stop on error
            clearInterval(interval);
            client.vcMoveIntervals.delete(targetUser.id);
            
            const errorEmbed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('❌ Movement Stopped - Error Occurred')
              .setDescription(`Movement stopped due to an error. User may have insufficient permissions or left the server.`)
              .addFields(
                { name: '📊 Total Moves', value: moveCount.toString(), inline: true },
                { name: '⏱️ Duration', value: `${Math.floor((Date.now() - startTime) / 1000)}s`, inline: true }
              )
              .setTimestamp();
            
            await interaction.followUp({ embeds: [errorEmbed] });
          }
        }, delay);

        // Store the interval for stopping later
        client.vcMoveIntervals.set(targetUser.id, {
          interval: interval,
          startTime: startTime,
          moveCount: 0,
          moderator: interaction.user.id,
          guildId: interaction.guild.id,
          targetUser: targetUser,
          speed: speed,
          channels: channelsToMove,
          allChannels: allChannels
        });

      } catch (error) {
        console.error('VC Move start error:', error);
        await interaction.reply({ 
          content: '❌ Failed to start continuous voice channel movement. Please check permissions and try again.', 
          ephemeral: true 
        });
      }
      return;
    }

    // VC Move Stop command
    if (commandName === 'vcmovestop') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.MoveMembers)) {
        await interaction.reply({ content: '❌ You need the "Move Members" permission to use this command.', ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user');

      // Initialize intervals map if it doesn't exist
      if (!client.vcMoveIntervals) {
        client.vcMoveIntervals = new Map();
      }

      if (targetUser) {
        // Stop movement for specific user
        if (client.vcMoveIntervals.has(targetUser.id)) {
          const moveData = client.vcMoveIntervals.get(targetUser.id);
          clearInterval(moveData.interval);
          client.vcMoveIntervals.delete(targetUser.id);

          const duration = Math.floor((Date.now() - moveData.startTime) / 1000);
          
          const embed = new EmbedBuilder()
            .setColor(0xFF6B35)
            .setTitle('⏹️ Voice Channel Movement Stopped')
            .setDescription(`Continuous movement stopped for **${targetUser.tag}**`)
            .addFields(
              { name: '👤 Target User', value: targetUser.tag, inline: true },
              { name: '⏱️ Total Duration', value: `${duration} seconds`, inline: true },
              { name: '👮 Stopped by', value: interaction.user.tag, inline: true },
              { name: '📊 Status', value: '🔴 Movement stopped successfully', inline: false }
            )
            .setFooter({ text: 'VC Movement Controller' })
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
        } else {
          await interaction.reply({ 
            content: `❌ No active movement found for **${targetUser.tag}**.`, 
            ephemeral: true 
          });
        }
      } else {
        // Stop all movements in this server
        const serverMovements = Array.from(client.vcMoveIntervals.entries())
          .filter(([userId, moveData]) => moveData.guildId === interaction.guild.id);

        if (serverMovements.length === 0) {
          await interaction.reply({ 
            content: '❌ No active voice channel movements found in this server.', 
            ephemeral: true 
          });
          return;
        }

        let stoppedCount = 0;
        const stoppedUsers = [];

        for (const [userId, moveData] of serverMovements) {
          clearInterval(moveData.interval);
          client.vcMoveIntervals.delete(userId);
          stoppedCount++;
          stoppedUsers.push(moveData.targetUser.tag);
        }

        const embed = new EmbedBuilder()
          .setColor(0xFF6B35)
          .setTitle('⏹️ All Voice Channel Movements Stopped')
          .setDescription(`Stopped ${stoppedCount} active movement${stoppedCount > 1 ? 's' : ''} in this server`)
          .addFields(
            { name: '📊 Stopped Movements', value: stoppedCount.toString(), inline: true },
            { name: '👮 Stopped by', value: interaction.user.tag, inline: true },
            { name: '🏰 Server', value: interaction.guild.name, inline: true }
          )
          .setFooter({ text: 'VC Movement Controller • All movements stopped' })
          .setTimestamp();

        if (stoppedUsers.length > 0) {
          const userList = stoppedUsers.slice(0, 10).join(', ');
          const extraUsers = stoppedUsers.length > 10 ? `... and ${stoppedUsers.length - 10} more` : '';
          embed.addFields({ name: '👥 Affected Users', value: userList + extraUsers, inline: false });
        }

        await interaction.reply({ embeds: [embed] });
      }
      return;
    }

    

// AI Chat Management Commands
    if (commandName === 'aistart') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ You need Administrator permission to manage AI chat settings.', ephemeral: true });
        return;
      }

      const settings = loadAIChatSettings();
      settings[interaction.guild.id] = { enabled: true };
      saveAIChatSettings(settings);

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('🤖 AI Chat Enabled')
        .setDescription('AI chat responses are now **enabled** for this server!')
        .addFields(
          { name: '✅ How to use', value: '• Mention the bot: @botname your message\n• Reply to bot messages\n• AI will respond automatically', inline: false },
          { name: '🛡️ Features', value: '• Smart conversation handling\n• Context-aware responses\n• Automatic message splitting\n• Error handling with fallbacks', inline: false },
          { name: '⚙️ Management', value: '• `/aistop` - Disable AI chat\n• `/aistatus` - Check current status\n• Only admins can manage AI settings', inline: false }
        )
        .setFooter({ text: `AI Chat enabled by ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      console.log(`🤖 AI Chat enabled in ${interaction.guild.name} by ${interaction.user.tag}`);
      return;
    }

    if (commandName === 'aistop') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ You need Administrator permission to manage AI chat settings.', ephemeral: true });
        return;
      }

      const settings = loadAIChatSettings();
      settings[interaction.guild.id] = { enabled: false };
      saveAIChatSettings(settings);

      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🤖 AI Chat Disabled')
        .setDescription('AI chat responses are now **disabled** for this server.')
        .addFields(
          { name: '❌ Status', value: 'The bot will no longer respond to mentions or replies with AI-generated messages.', inline: false },
          { name: '🔄 Re-enable', value: 'Use `/aistart` to enable AI chat responses again.', inline: false },
          { name: '⚙️ Other Features', value: 'All other bot features (music, moderation, etc.) remain fully functional.', inline: false }
        )
        .setFooter({ text: `AI Chat disabled by ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      console.log(`🤖 AI Chat disabled in ${interaction.guild.name} by ${interaction.user.tag}`);
      return;
    }

    if (commandName === 'aistatus') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ You need Administrator permission to view AI chat settings.', ephemeral: true });
        return;
      }

      const settings = loadAIChatSettings();
      const guildSettings = settings[interaction.guild.id];
      const isEnabled = guildSettings && guildSettings.enabled;

      const embed = new EmbedBuilder()
        .setColor(isEnabled ? 0x00FF00 : 0xFF0000)
        .setTitle('🤖 AI Chat Status')
        .setDescription(`AI chat responses are currently **${isEnabled ? 'ENABLED' : 'DISABLED'}** for this server.`)
        .addFields(
          { name: '🏰 Server', value: interaction.guild.name, inline: true },
          { name: '📊 Status', value: isEnabled ? '✅ Active' : '❌ Inactive', inline: true },
          { name: '🔧 AI Model', value: 'Hercai v3-32k', inline: true }
        );

      if (isEnabled) {
        embed.addFields(
          { name: '💬 How AI Responds', value: '• When users mention the bot\n• When users reply to bot messages\n• Smart context understanding', inline: false },
          { name: '⚙️ Management', value: '• `/aistop` - Disable AI chat\n• Only administrators can change settings', inline: false }
        );
      } else {
        embed.addFields(
          { name: '🔄 Enable AI Chat', value: 'Use `/aistart` to enable AI responses for this server.', inline: false },
          { name: '🤖 Other Features', value: 'Music, moderation, and utility commands are still available.', inline: false }
        );
      }

      embed.setFooter({ text: `Checked by ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // Sticky Note Commands
    if (commandName === 'sticknote') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const title = interaction.options.getString('title');
      const text = interaction.options.getString('text');
      const author = interaction.options.getString('author');
      const image = interaction.options.getAttachment('image');
      const thumbnail = interaction.options.getString('thumbnail');
      const color = interaction.options.getString('color');
      const persistent = interaction.options.getBoolean('persistent') ?? true;
      const allChannels = interaction.options.getBoolean('all_channels') ?? false;

      // Validate inputs
      if (title.length > 256) {
        await interaction.reply({ content: '❌ Title must be 256 characters or less.', ephemeral: true });
        return;
      }

      if (text.length > 4096) {
        await interaction.reply({ content: '❌ Text must be 4096 characters or less.', ephemeral: true });
        return;
      }

      let imageUrl = null;
      if (image) {
        const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
        if (!validTypes.includes(image.contentType)) {
          await interaction.reply({ content: '❌ Invalid image format. Supported: PNG, JPG, GIF, WEBP', ephemeral: true });
          return;
        }
        imageUrl = image.url;
      }

      if (thumbnail && !thumbnail.startsWith('http')) {
        await interaction.reply({ content: '❌ Thumbnail must be a valid URL starting with http:// or https://', ephemeral: true });
        return;
      }

      if (color && !/^[0-9A-F]{6}$/i.test(color)) {
        await interaction.reply({ content: '❌ Color must be a valid hex code (e.g., FF0000)', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      if (allChannels) {
        // Check if global sticky note with this title already exists
        if (globalStickyNotes.has(title)) {
          await interaction.editReply({ content: '❌ A global sticky note with this title already exists. Use a different title or remove the existing one first.' });
          return;
        }

        // Deploy to all channels
        const result = await deployGlobalStickyNote(interaction.guild, {
          title,
          text,
          author,
          imageUrl,
          thumbnailUrl: thumbnail,
          color,
          persistent
        });

        if (result.success) {
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🌐 Global Sticky Note Deployed')
            .setDescription(`Successfully deployed sticky note to **${result.successCount}** channels!`)
            .addFields(
              { name: '📌 Title', value: title, inline: true },
              { name: '✅ Successfully Deployed', value: result.successCount.toString(), inline: true },
              { name: '❌ Failed Deployments', value: result.failCount.toString(), inline: true },
              { name: '📊 Total Channels Checked', value: result.totalChannels.toString(), inline: true },
              { name: '🔄 Persistent Mode', value: persistent ? '✅ Enabled' : '❌ Disabled', inline: true },
              { name: '👤 Created By', value: interaction.user.tag, inline: true }
            )
            .setTimestamp();

          if (result.deployedChannels.length > 0) {
            const channelList = result.deployedChannels.slice(0, 10).map(ch => `#${ch.name}`).join(', ');
            const extraChannels = result.deployedChannels.length > 10 ? `... and ${result.deployedChannels.length - 10} more` : '';
            embed.addFields({ name: '📋 Deployed Channels', value: channelList + extraChannels, inline: false });
          }

          embed.setFooter({ text: 'Global Sticky Note System • Permanent deployment across all channels' });

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ content: '❌ Failed to deploy global sticky note. Please try again.' });
        }
      } else {
        // Single channel deployment
        if (stickyNotes.has(interaction.channel.id)) {
          await interaction.editReply({ content: '❌ A sticky note already exists in this channel. Use `/updatesticknote` to modify it or `/removesticknote` to remove it first.' });
          return;
        }

        const result = await createStickyNote(interaction.channel, {
          title,
          text,
          author,
          imageUrl,
          thumbnailUrl: thumbnail,
          color,
          persistent
        });

        if (result.success) {
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Sticky Note Created')
            .addFields(
              { name: 'Title', value: title, inline: true },
              { name: 'Channel', value: interaction.channel.toString(), inline: true },
              { name: 'Persistent', value: persistent ? '✅ Yes' : '❌ No', inline: true },
              { name: 'Author', value: author || 'None', inline: true },
              { name: 'Color', value: color ? `#${color.toUpperCase()}` : 'Default', inline: true },
              { name: 'Created By', value: interaction.user.tag, inline: true }
            )
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({ content: `❌ Failed to create sticky note: ${result.error}` });
        }
      }
      return;
    }

    if (commandName === 'removesticknote') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const result = await removeStickyNote(interaction.channel);

      if (result.success) {
        await interaction.reply({ 
          content: '✅ Sticky note removed successfully!', 
          ephemeral: true 
        });
      } else {
        await interaction.reply({ 
          content: `❌ ${result.error}`, 
          ephemeral: true 
        });
      }
      return;
    }

    if (commandName === 'liststicknotes') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const guildNotes = Array.from(stickyNotes.values()).filter(note => note.guildId === interaction.guild.id);

      if (guildNotes.length === 0) {
        await interaction.reply({ 
          content: 'No sticky notes found in this server.', 
          ephemeral: true 
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle(`📌 Sticky Notes in ${interaction.guild.name}`)
        .setDescription(`Found ${guildNotes.length} sticky note(s)`)
        .setTimestamp();

      for (const note of guildNotes.slice(0, 10)) {
        const channel = interaction.guild.channels.cache.get(note.channelId);
        const channelName = channel ? channel.name : 'Unknown Channel';
        const created = new Date(note.createdAt).toLocaleDateString();

        embed.addFields({
          name: `📌 ${note.title}`,
          value: `**Channel:** #${channelName}\n**Created:** ${created}\n**Persistent:** ${note.persistent ? '✅' : '❌'}\n**Author:** ${note.author || 'None'}`,
          inline: false
        });
      }

      if (guildNotes.length > 10) {
        embed.setFooter({ text: `Showing first 10 of ${guildNotes.length} sticky notes` });
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (commandName === 'updatesticknote') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const noteData = stickyNotes.get(interaction.channel.id);
      if (!noteData) {
        await interaction.reply({ 
          content: '❌ No sticky note found in this channel. Use `/sticknote` to create one.', 
          ephemeral: true 
        });
        return;
      }

      const title = interaction.options.getString('title') || noteData.title;
      const text = interaction.options.getString('text') || noteData.text;
      const author = interaction.options.getString('author') || noteData.author;
      const image = interaction.options.getAttachment('image');
      const thumbnail = interaction.options.getString('thumbnail') || noteData.thumbnailUrl;
      const color = interaction.options.getString('color') || noteData.color;
      const persistent = interaction.options.getBoolean('persistent') ?? noteData.persistent;

      // Validation
      if (title.length > 256) {
        await interaction.reply({ content: '❌ Title must be 256 characters or less.', ephemeral: true });
        return;
      }

      if (text.length > 4096) {
        await interaction.reply({ content: '❌ Text must be 4096 characters or less.', ephemeral: true });
        return;
      }

      let imageUrl = noteData.imageUrl;
      if (image) {
        const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
        if (!validTypes.includes(image.contentType)) {
          await interaction.reply({ content: '❌ Invalid image format. Supported: PNG, JPG, GIF, WEBP', ephemeral: true });
          return;
        }
        imageUrl = image.url;
      }

      await interaction.deferReply({ ephemeral: true });

      // Remove old sticky note
      await removeStickyNote(interaction.channel);

      // Create updated sticky note
      const result = await createStickyNote(interaction.channel, {
        title,
        text,
        author,
        imageUrl,
        thumbnailUrl: thumbnail,
        color,
        persistent
      });

      if (result.success) {
        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('✅ Sticky Note Updated')
          .addFields(
            { name: 'Title', value: title, inline: true },
            { name: 'Channel', value: interaction.channel.toString(), inline: true },
            { name: 'Persistent', value: persistent ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Updated By', value: interaction.user.tag, inline: true }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({ content: `❌ Failed to update sticky note: ${result.error}` });
      }
      return;
    }

    // Separate Edit Commands for Sticky Notes

    if (commandName === 'editstickytitle') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const noteData = stickyNotes.get(interaction.channel.id);
      if (!noteData) {
        await interaction.reply({ 
          content: '❌ No sticky note found in this channel. Use `/sticknote` to create one.', 
          ephemeral: true 
        });
        return;
      }

      const newTitle = interaction.options.getString('title');

      if (newTitle.length > 256) {
        await interaction.reply({ content: '❌ Title must be 256 characters or less.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      // Update only the title
      await removeStickyNote(interaction.channel);
      const result = await createStickyNote(interaction.channel, {
        title: newTitle,
        text: noteData.text,
        author: noteData.author,
        imageUrl: noteData.imageUrl,
        thumbnailUrl: noteData.thumbnailUrl,
        color: noteData.color,
        persistent: noteData.persistent
      });

      if (result.success) {
        await interaction.editReply({ 
          content: `✅ **Sticky Note Title Updated**\n\n**Old Title:** ${noteData.title}\n**New Title:** ${newTitle}\n\n🔄 Sticky note has been refreshed with the new title.` 
        });
      } else {
        await interaction.editReply({ content: `❌ Failed to update title: ${result.error}` });
      }
      return;
    }

    if (commandName === 'editstickytext') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const noteData = stickyNotes.get(interaction.channel.id);
      if (!noteData) {
        await interaction.reply({ 
          content: '❌ No sticky note found in this channel. Use `/sticknote` to create one.', 
          ephemeral: true 
        });
        return;
      }

      const newText = interaction.options.getString('text');

      if (newText.length > 4096) {
        await interaction.reply({ content: '❌ Text must be 4096 characters or less.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      // Update only the text
      await removeStickyNote(interaction.channel);
      const result = await createStickyNote(interaction.channel, {
        title: noteData.title,
        text: newText,
        author: noteData.author,
        imageUrl: noteData.imageUrl,
        thumbnailUrl: noteData.thumbnailUrl,
        color: noteData.color,
        persistent: noteData.persistent
      });

      if (result.success) {
        await interaction.editReply({ 
          content: `✅ **Sticky Note Text Updated**\n\n**Character Count:** ${newText.length} / 4096\n\n🔄 Sticky note has been refreshed with the new text content.` 
        });
      } else {
        await interaction.editReply({ content: `❌ Failed to update text: ${result.error}` });
      }
      return;
    }

    if (commandName === 'editstickyauthor') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const noteData = stickyNotes.get(interaction.channel.id);
      if (!noteData) {
        await interaction.reply({ 
          content: '❌ No sticky note found in this channel. Use `/sticknote` to create one.', 
          ephemeral: true 
        });
        return;
      }

      const newAuthor = interaction.options.getString('author') || null;

      await interaction.deferReply({ ephemeral: true });

      // Update only the author
      await removeStickyNote(interaction.channel);
      const result = await createStickyNote(interaction.channel, {
        title: noteData.title,
        text: noteData.text,
        author: newAuthor,
        imageUrl: noteData.imageUrl,
        thumbnailUrl: noteData.thumbnailUrl,
        color: noteData.color,
        persistent: noteData.persistent
      });

      if (result.success) {
        const authorUpdate = newAuthor ? `**New Author:** ${newAuthor}` : '**Author Removed**';
        await interaction.editReply({ 
          content: `✅ **Sticky Note Author Updated**\n\n**Old Author:** ${noteData.author || 'None'}\n${authorUpdate}\n\n🔄 Sticky note has been refreshed with the new author.` 
        });
      } else {
        await interaction.editReply({ content: `❌ Failed to update author: ${result.error}` });
      }
      return;
    }

    if (commandName === 'editstickyimage') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const noteData = stickyNotes.get(interaction.channel.id);
      if (!noteData) {
        await interaction.reply({ 
          content: '❌ No sticky note found in this channel. Use `/sticknote` to create one.', 
          ephemeral: true 
        });
        return;
      }

      const newImage = interaction.options.getAttachment('image');
      let newImageUrl = null;

      if (newImage) {
        const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
        if (!validTypes.includes(newImage.contentType)) {
          await interaction.reply({ content: '❌ Invalid image format. Supported: PNG, JPG, GIF, WEBP', ephemeral: true });
          return;
        }
        newImageUrl = newImage.url;
      }

      await interaction.deferReply({ ephemeral: true });

      // Update only the image
      await removeStickyNote(interaction.channel);
      const result = await createStickyNote(interaction.channel, {
        title: noteData.title,
        text: noteData.text,
        author: noteData.author,
        imageUrl: newImageUrl,
        thumbnailUrl: noteData.thumbnailUrl,
        color: noteData.color,
        persistent: noteData.persistent
      });

      if (result.success) {
        const imageUpdate = newImageUrl ? '**New Image:** Uploaded successfully' : '**Image Removed**';
        await interaction.editReply({ 
          content: `✅ **Sticky Note Image Updated**\n\n**Previous:** ${noteData.imageUrl ? 'Had image' : 'No image'}\n${imageUpdate}\n\n🔄 Sticky note has been refreshed with the updated image.` 
        });
      } else {
        await interaction.editReply({ content: `❌ Failed to update image: ${result.error}` });
      }
      return;
    }

    if (commandName === 'editstickythumbnail') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const noteData = stickyNotes.get(interaction.channel.id);
      if (!noteData) {
        await interaction.reply({ 
          content: '❌ No sticky note found in this channel. Use `/sticknote` to create one.', 
          ephemeral: true 
        });
        return;
      }

      const newThumbnail = interaction.options.getString('thumbnail') || null;

      if (newThumbnail && !newThumbnail.startsWith('http')) {
        await interaction.reply({ content: '❌ Thumbnail must be a valid URL starting with http:// or https://', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      // Update only the thumbnail
      await removeStickyNote(interaction.channel);
      const result = await createStickyNote(interaction.channel, {
        title: noteData.title,
        text: noteData.text,
        author: noteData.author,
        imageUrl: noteData.imageUrl,
        thumbnailUrl: newThumbnail,
        color: noteData.color,
        persistent: noteData.persistent
      });

      if (result.success) {
        const thumbnailUpdate = newThumbnail ? `**New Thumbnail:** ${newThumbnail}` : '**Thumbnail Removed**';
        await interaction.editReply({ 
          content: `✅ **Sticky Note Thumbnail Updated**\n\n**Previous:** ${noteData.thumbnailUrl || 'No thumbnail'}\n${thumbnailUpdate}\n\n🔄 Sticky note has been refreshed with the updated thumbnail.` 
        });
      } else {
        await interaction.editReply({ content: `❌ Failed to update thumbnail: ${result.error}` });
      }
      return;
    }

    if (commandName === 'editstickycolor') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const noteData = stickyNotes.get(interaction.channel.id);
      if (!noteData) {
        await interaction.reply({ 
          content: '❌ No sticky note found in this channel. Use `/sticknote` to create one.', 
          ephemeral: true 
        });
        return;
      }

      const newColor = interaction.options.getString('color') || null;

      if (newColor && !/^[0-9A-F]{6}$/i.test(newColor)) {
        await interaction.reply({ content: '❌ Color must be a valid hex code (e.g., FF0000)', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      // Update only the color
      await removeStickyNote(interaction.channel);
      const result = await createStickyNote(interaction.channel, {
        title: noteData.title,
        text: noteData.text,
        author: noteData.author,
        imageUrl: noteData.imageUrl,
        thumbnailUrl: noteData.thumbnailUrl,
        color: newColor,
        persistent: noteData.persistent
      });

      if (result.success) {
        const colorUpdate = newColor ? `**New Color:** #${newColor.toUpperCase()}` : '**Color Reset to Default**';
        await interaction.editReply({ 
          content: `✅ **Sticky Note Color Updated**\n\n**Previous:** ${noteData.color ? `#${noteData.color.toUpperCase()}` : 'Default'}\n${colorUpdate}\n\n🔄 Sticky note has been refreshed with the new color.` 
        });
      } else {
        await interaction.editReply({ content: `❌ Failed to update color: ${result.error}` });
      }
      return;
    }

    if (commandName === 'editstickypersistent') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const noteData = stickyNotes.get(interaction.channel.id);
      if (!noteData) {
        await interaction.reply({ 
          content: '❌ No sticky note found in this channel. Use `/sticknote` to create one.', 
          ephemeral: true 
        });
        return;
      }

      const newPersistent = interaction.options.getBoolean('persistent');

      await interaction.deferReply({ ephemeral: true });

      // Update only the persistent setting
      await removeStickyNote(interaction.channel);
      const result = await createStickyNote(interaction.channel, {
        title: noteData.title,
        text: noteData.text,
        author: noteData.author,
        imageUrl: noteData.imageUrl,
        thumbnailUrl: noteData.thumbnailUrl,
        color: noteData.color,
        persistent: newPersistent
      });

      if (result.success) {
        const persistentUpdate = newPersistent ? '✅ **Enabled** - Will auto-repost if deleted' : '❌ **Disabled** - Will not auto-repost if deleted';
        await interaction.editReply({ 
          content: `✅ **Sticky Note Persistence Updated**\n\n**Previous:** ${noteData.persistent ? 'Enabled' : 'Disabled'}\n**New Setting:** ${persistentUpdate}\n\n🔄 Sticky note has been refreshed with the new persistence setting.` 
        });
      } else {
        await interaction.editReply({ content: `❌ Failed to update persistence: ${result.error}` });
      }
      return;
    }

    if (commandName === 'listglobalstickynotes') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const guildGlobalNotes = Array.from(globalStickyNotes.values()).filter(note => note.guildId === interaction.guild.id);

      if (guildGlobalNotes.length === 0) {
        await interaction.reply({ 
          content: 'No global sticky notes found in this server.', 
          ephemeral: true 
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle(`🌐 Global Sticky Notes in ${interaction.guild.name}`)
        .setDescription(`Found ${guildGlobalNotes.length} global sticky note(s)`)
        .setTimestamp();

      for (const note of guildGlobalNotes.slice(0, 5)) {
        const created = new Date(note.createdAt).toLocaleDateString();
        embed.addFields({
          name: `🌐 ${note.title}`,
          value: `**Deployed to:** ${note.deployedChannels.length} channels\n**Created:** ${created}\n**Persistent:** ${note.persistent ? '✅' : '❌'}\n**Author:** ${note.author || 'None'}`,
          inline: false
        });
      }

      if (guildGlobalNotes.length > 5) {
        embed.setFooter({ text: `Showing first 5 of ${guildGlobalNotes.length} global sticky notes` });
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (commandName === 'removeglobalstickynote') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
        return;
      }

      const title = interaction.options.getString('title');
      const globalNote = globalStickyNotes.get(title);

      if (!globalNote || globalNote.guildId !== interaction.guild.id) {
        await interaction.reply({ 
          content: `❌ Global sticky note "${title}" not found in this server.`, 
          ephemeral: true 
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      let removedCount = 0;
      let failedCount = 0;

      // Remove from all deployed channels
      for (const channelInfo of globalNote.deployedChannels) {
        try {
          const channel = interaction.guild.channels.cache.get(channelInfo.id);
          if (channel) {
            const noteData = stickyNotes.get(channelInfo.id);
            if (noteData && noteData.globalTitle === title) {
              try {
                const message = await channel.messages.fetch(noteData.messageId);
                await message.delete();
              } catch (error) {
                // Message might already be deleted
              }
              stickyNotes.delete(channelInfo.id);
              removedCount++;
            }
          }
        } catch (error) {
          console.error(`Failed to remove from ${channelInfo.name}:`, error);
          failedCount++;
        }
      }

      // Remove global sticky note reference
      globalStickyNotes.delete(title);
      saveStickyNotes();
      saveGlobalStickyNotes();

      const embed = new EmbedBuilder()
        .setColor(0xFF6B35)
        .setTitle('🗑️ Global Sticky Note Removed')
        .setDescription(`Successfully removed global sticky note "${title}"`)
        .addFields(
          { name: '✅ Removed from Channels', value: removedCount.toString(), inline: true },
          { name: '❌ Failed Removals', value: failedCount.toString(), inline: true },
          { name: '📊 Total Channels', value: globalNote.deployedChannels.length.toString(), inline: true },
          { name: '👤 Removed By', value: interaction.user.tag, inline: true }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Enhanced DM Commands

    // Enhanced DM command
    if (commandName === 'dm') {
      const targetUser = interaction.options.getUser('user');
      const message = interaction.options.getString('message');
      const anonymous = interaction.options.getBoolean('anonymous') || false;
      const urgent = interaction.options.getBoolean('urgent') || false;
      const replyChannel = interaction.options.getString('reply_channel');

      if (targetUser.id === interaction.user.id) {
        await interaction.reply({
          content: '❌ You cannot send a DM to yourself!',
          ephemeral: true
        });
        return;
      }

      if (targetUser.bot) {
        await interaction.reply({
          content: '❌ You cannot send DMs to bots!',
          ephemeral: true
        });
        return;
      }

      // Check message length
      if (message.length > 2000) {
        await interaction.reply({
          content: '❌ Message is too long! Maximum 2000 characters allowed.',
          ephemeral: true
        });
        return;
      }

      try {
        let dmContent = message;
        const urgentPrefix = urgent ? '🚨 **URGENT MESSAGE** 🚨\n\n' : '';
        
        if (!anonymous) {
          dmContent = `${urgentPrefix}**Message from ${interaction.user.tag} in ${interaction.guild.name}:**\n\n${message}`;
          if (replyChannel) {
            dmContent += `\n\n*Reply to this message will be forwarded to the sender.*`;
          }
        } else {
          dmContent = `${urgentPrefix}**Anonymous message:**\n\n${message}`;
        }

        await targetUser.send(dmContent);

        const embed = new EmbedBuilder()
          .setColor(urgent ? 0xFF0000 : 0x00AE86)
          .setTitle('✅ DM Sent Successfully')
          .addFields(
            { name: 'Recipient', value: targetUser.tag, inline: true },
            { name: 'Message Length', value: `${message.length} characters`, inline: true },
            { name: 'Type', value: urgent ? '🚨 Urgent' : '📧 Normal', inline: true },
            { name: 'Anonymous', value: anonymous ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Server', value: interaction.guild.name, inline: true },
            { name: 'Channel', value: interaction.channel.name, inline: true }
          )
          .setFooter({ text: `Sent by ${interaction.user.tag}` })
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (error) {
        console.error('Enhanced DM send error:', error);
        await interaction.reply({
          content: '❌ Failed to send DM. The user may have DMs disabled, blocked the bot, or left the server.',
          ephemeral: true
        });
      }
      return;
    }

    // Enhanced DM Link command
    if (commandName === 'dmlink') {
      const targetUser = interaction.options.getUser('user');
      const link = interaction.options.getString('link');
      const message = interaction.options.getString('message');
      const title = interaction.options.getString('title');
      const anonymous = interaction.options.getBoolean('anonymous') || false;
      const preview = interaction.options.getBoolean('preview') || false;

      if (targetUser.id === interaction.user.id) {
        await interaction.reply({
          content: '❌ You cannot send a DM to yourself!',
          ephemeral: true
        });
        return;
      }

      if (targetUser.bot) {
        await interaction.reply({
          content: '❌ You cannot send DMs to bots!',
          ephemeral: true
        });
        return;
      }

      // Validate link
      if (!link.startsWith('http://') && !link.startsWith('https://')) {
        await interaction.reply({
          content: '❌ Invalid link format. Links must start with http:// or https://',
          ephemeral: true
        });
        return;
      }

      // Check for potentially dangerous links
      const dangerousDomains = ['discord.gg', 'discordapp.com/invite', 'discord.com/invite'];
      const lowerLink = link.toLowerCase();
      const isDangerous = dangerousDomains.some(domain => lowerLink.includes(domain));

      try {
        let dmContent = '';
        
        if (message) {
          dmContent = `${message}\n\n`;
        }

        if (preview) {
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle(title || '🔗 Shared Link')
            .setDescription(message || 'Someone shared a link with you!')
            .addFields({ name: 'Link', value: `[Click here to visit](${link})`, inline: false })
            .setTimestamp();

          if (!anonymous) {
            embed.setFooter({ 
              text: `Shared by ${interaction.user.tag} from ${interaction.guild.name}`,
              iconURL: interaction.user.displayAvatarURL()
            });
          }

          await targetUser.send({ embeds: [embed] });
        } else {
          dmContent += `🔗 **${title || 'Link'}:** ${link}`;
          
          if (isDangerous) {
            dmContent += '\n\n⚠️ **Warning:** This appears to be a Discord invite link. Please be cautious.';
          }

          if (!anonymous) {
            dmContent = `**Link from ${interaction.user.tag} in ${interaction.guild.name}:**\n\n${dmContent}`;
          }

          await targetUser.send(dmContent);
        }

        const embed = new EmbedBuilder()
          .setColor(0x00AE86)
          .setTitle('✅ Link Sent Successfully')
          .addFields(
            { name: 'Recipient', value: targetUser.tag, inline: true },
            { name: 'Link Type', value: preview ? '📋 Embed Preview' : '🔗 Direct Link', inline: true },
            { name: 'Title', value: title || 'No custom title', inline: true },
            { name: 'Anonymous', value: anonymous ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Warning Issued', value: isDangerous ? '⚠️ Yes' : '✅ Safe', inline: true },
            { name: 'Link', value: link.length > 50 ? link.substring(0, 50) + '...' : link, inline: false }
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (error) {
        console.error('Enhanced DM link send error:', error);
        await interaction.reply({
          content: '❌ Failed to send DM link. The user may have DMs disabled or blocked the bot.',
          ephemeral: true
        });
      }
      return;
    }

    // Enhanced DM Image command
    if (commandName === 'dmimage') {
      const targetUser = interaction.options.getUser('user');
      const image = interaction.options.getAttachment('image');
      const message = interaction.options.getString('message');
      const altText = interaction.options.getString('alt_text');
      const anonymous = interaction.options.getBoolean('anonymous') || false;
      const spoiler = interaction.options.getBoolean('spoiler') || false;

      if (targetUser.id === interaction.user.id) {
        await interaction.reply({
          content: '❌ You cannot send a DM to yourself!',
          ephemeral: true
        });
        return;
      }

      if (targetUser.bot) {
        await interaction.reply({
          content: '❌ You cannot send DMs to bots!',
          ephemeral: true
        });
        return;
      }

      // Validate image
      const validImageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp'];
      if (!image.contentType || !validImageTypes.includes(image.contentType)) {
        await interaction.reply({
          content: '❌ Invalid file type. Supported formats: PNG, JPG, JPEG, GIF, WEBP, BMP',
          ephemeral: true
        });
        return;
      }

      // Check file size (8MB limit)
      if (image.size > 8 * 1024 * 1024) {
        await interaction.reply({
          content: '❌ Image file is too large. Maximum size is 8MB.',
          ephemeral: true
        });
        return;
      }

      try {
        let dmContent = '';
        
        if (message) {
          dmContent = message;
        }

        if (altText) {
          dmContent += `${dmContent ? '\n\n' : ''}📝 **Alt text:** ${altText}`;
        }

        if (!anonymous) {
          const prefix = `**Image from ${interaction.user.tag} in ${interaction.guild.name}:**`;
          dmContent = dmContent ? `${prefix}\n\n${dmContent}` : prefix;
        }

        // Handle spoiler
        let fileName = image.name;
        if (spoiler && !fileName.startsWith('SPOILER_')) {
          fileName = `SPOILER_${fileName}`;
        }

        const dmMessage = {
          content: dmContent || undefined,
          files: [{
            attachment: image.url,
            name: fileName,
            description: altText || undefined
          }]
        };

        await targetUser.send(dmMessage);

        const embed = new EmbedBuilder()
          .setColor(spoiler ? 0xFF6B35 : 0x00AE86)
          .setTitle('✅ Image Sent Successfully')
          .addFields(
            { name: 'Recipient', value: targetUser.tag, inline: true },
            { name: 'File Type', value: image.contentType.split('/')[1].toUpperCase(), inline: true },
            { name: 'File Size', value: `${(image.size / 1024 / 1024).toFixed(2)} MB`, inline: true },
            { name: 'Dimensions', value: `${image.width || 'Unknown'} x ${image.height || 'Unknown'}`, inline: true },
            { name: 'Spoiler', value: spoiler ? '🔒 Yes' : '👁️ No', inline: true },
            { name: 'Anonymous', value: anonymous ? '✅ Yes' : '❌ No', inline: true }
          )
          .setFooter({ text: `Original filename: ${image.name}` })
          .setTimestamp();

        if (altText) {
          embed.addFields({ name: 'Alt Text', value: altText, inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (error) {
        console.error('Enhanced DM image send error:', error);
        await interaction.reply({
          content: '❌ Failed to send DM image. The user may have DMs disabled, blocked the bot, or the file may be corrupted.',
          ephemeral: true
        });
      }
      return;
    }

    // Enhanced DM Video command
    if (commandName === 'dmvideo') {
      const targetUser = interaction.options.getUser('user');
      const video = interaction.options.getAttachment('video');
      const message = interaction.options.getString('message');
      const thumbnail = interaction.options.getString('thumbnail');
      const anonymous = interaction.options.getBoolean('anonymous') || false;
      const spoiler = interaction.options.getBoolean('spoiler') || false;

      if (targetUser.id === interaction.user.id) {
        await interaction.reply({
          content: '❌ You cannot send a DM to yourself!',
          ephemeral: true
        });
        return;
      }

      if (targetUser.bot) {
        await interaction.reply({
          content: '❌ You cannot send DMs to bots!',
          ephemeral: true
        });
        return;
      }

      // Validate video
      const validVideoTypes = ['video/mp4', 'video/mov', 'video/avi', 'video/webm', 'video/mkv', 'video/flv'];
      if (!video.contentType || !validVideoTypes.includes(video.contentType)) {
        await interaction.reply({
          content: '❌ Invalid file type. Supported formats: MP4, MOV, AVI, WEBM, MKV, FLV',
          ephemeral: true
        });
        return;
      }

      // Check file size (8MB limit)
      if (video.size > 8 * 1024 * 1024) {
        await interaction.reply({
          content: '❌ Video file is too large. Maximum size is 8MB.',
          ephemeral: true
        });
        return;
      }

      // Validate thumbnail URL if provided
      if (thumbnail && !thumbnail.startsWith('http://') && !thumbnail.startsWith('https://')) {
        await interaction.reply({
          content: '❌ Invalid thumbnail URL. Must start with http:// or https://',
          ephemeral: true
        });
        return;
      }

      try {
        let dmContent = '';
        
        if (message) {
          dmContent = message;
        }

        if (thumbnail) {
          dmContent += `${dmContent ? '\n\n' : ''}🖼️ **Custom thumbnail:** ${thumbnail}`;
        }

        if (!anonymous) {
          const prefix = `**Video from ${interaction.user.tag} in ${interaction.guild.name}:**`;
          dmContent = dmContent ? `${prefix}\n\n${dmContent}` : prefix;
        }

        // Handle spoiler
        let fileName = video.name;
        if (spoiler && !fileName.startsWith('SPOILER_')) {
          fileName = `SPOILER_${fileName}`;
        }

        const dmMessage = {
          content: dmContent || undefined,
          files: [{
            attachment: video.url,
            name: fileName
          }]
        };

        await targetUser.send(dmMessage);

        // Calculate video duration estimate (rough estimate based on file size)
        const estimatedDuration = Math.round(video.size / (1024 * 1024) * 10); // Very rough estimate

        const embed = new EmbedBuilder()
          .setColor(spoiler ? 0xFF6B35 : 0x9B59B6)
          .setTitle('✅ Video Sent Successfully')
          .addFields(
            { name: 'Recipient', value: targetUser.tag, inline: true },
            { name: 'Video Format', value: video.contentType.split('/')[1].toUpperCase(), inline: true },
            { name: 'File Size', value: `${(video.size / 1024 / 1024).toFixed(2)} MB`, inline: true },
            { name: 'Estimated Duration', value: `~${estimatedDuration}s`, inline: true },
            { name: 'Spoiler', value: spoiler ? '🔒 Yes' : '👁️ No', inline: true },
            { name: 'Anonymous', value: anonymous ? '✅ Yes' : '❌ No', inline: true }
          )
          .setFooter({ text: `Original filename: ${video.name}` })
          .setTimestamp();

        if (thumbnail) {
          embed.addFields({ name: 'Custom Thumbnail', value: thumbnail, inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (error) {
        console.error('Enhanced DM video send error:', error);
        await interaction.reply({
          content: '❌ Failed to send DM video. The user may have DMs disabled, blocked the bot, or the file may be corrupted.',
          ephemeral: true
        });
      }
      return;
    }

    // Enhanced DM Embed command
    if (commandName === 'dmembed') {
      const targetUser = interaction.options.getUser('user');
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const color = interaction.options.getString('color') || '00AE86';
      const imageUrl = interaction.options.getString('image_url');
      const thumbnailUrl = interaction.options.getString('thumbnail_url');
      const footerText = interaction.options.getString('footer_text');
      const authorName = interaction.options.getString('author_name');
      const anonymous = interaction.options.getBoolean('anonymous') || false;
      const addTimestamp = interaction.options.getBoolean('timestamp') || false;

      if (targetUser.id === interaction.user.id) {
        await interaction.reply({
          content: '❌ You cannot send a DM to yourself!',
          ephemeral: true
        });
        return;
      }

      if (targetUser.bot) {
        await interaction.reply({
          content: '❌ You cannot send DMs to bots!',
          ephemeral: true
        });
        return;
      }

      // Validate color
      const hexColor = color.replace('#', '');
      if (!/^[0-9A-F]{6}$/i.test(hexColor)) {
        await interaction.reply({
          content: '❌ Invalid color format. Please use a valid hex color code (e.g., FF0000 for red).',
          ephemeral: true
        });
        return;
      }

      // Validate URLs if provided
      const urlFields = [
        { name: 'image_url', value: imageUrl },
        { name: 'thumbnail_url', value: thumbnailUrl }
      ];

      for (const field of urlFields) {
        if (field.value && !field.value.startsWith('http://') && !field.value.startsWith('https://')) {
          await interaction.reply({
            content: `❌ Invalid ${field.name.replace('_', ' ')}. URLs must start with http:// or https://`,
            ephemeral: true
          });
          return;
        }
      }

      // Check content lengths
      if (title.length > 256) {
        await interaction.reply({
          content: '❌ Title is too long! Maximum 256 characters allowed.',
          ephemeral: true
        });
        return;
      }

      if (description.length > 4096) {
        await interaction.reply({
          content: '❌ Description is too long! Maximum 4096 characters allowed.',
          ephemeral: true
        });
        return;
      }

      try {
        const embed = new EmbedBuilder()
          .setColor(parseInt(hexColor, 16))
          .setTitle(title)
          .setDescription(description);

        if (imageUrl) {
          embed.setImage(imageUrl);
        }

        if (thumbnailUrl) {
          embed.setThumbnail(thumbnailUrl);
        }

        if (authorName) {
          embed.setAuthor({ name: authorName });
        }

        if (addTimestamp) {
          embed.setTimestamp();
        }

        if (footerText && !anonymous) {
          embed.setFooter({
            text: `${footerText} • Sent by ${interaction.user.tag} from ${interaction.guild.name}`,
            iconURL: interaction.user.displayAvatarURL()
          });
        } else if (footerText) {
          embed.setFooter({ text: footerText });
        } else if (!anonymous) {
          embed.setFooter({
            text: `Sent by ${interaction.user.tag} from ${interaction.guild.name}`,
            iconURL: interaction.user.displayAvatarURL()
          });
        }

        await targetUser.send({ embeds: [embed] });

        const confirmEmbed = new EmbedBuilder()
          .setColor(0x00AE86)
          .setTitle('✅ Rich Embed Sent Successfully')
          .addFields(
            { name: 'Recipient', value: targetUser.tag, inline: true },
            { name: 'Title Length', value: `${title.length}/256 chars`, inline: true },
            { name: 'Description Length', value: `${description.length}/4096 chars`, inline: true },
            { name: 'Color', value: `#${hexColor.toUpperCase()}`, inline: true },
            { name: 'Features', value: [
              imageUrl ? '🖼️ Image' : null,
              thumbnailUrl ? '🔳 Thumbnail' : null,
              authorName ? '👤 Author' : null,
              footerText ? '📝 Footer' : null,
              addTimestamp ? '⏰ Timestamp' : null
            ].filter(Boolean).join(', ') || 'Basic embed', inline: true },
            { name: 'Anonymous', value: anonymous ? '✅ Yes' : '❌ No', inline: true }
          )
          .setFooter({ text: `Embed color preview` })
          .setColor(parseInt(hexColor, 16))
          .setTimestamp();

        await interaction.reply({ embeds: [confirmEmbed], ephemeral: true });
      } catch (error) {
        console.error('Enhanced DM embed send error:', error);
        await interaction.reply({
          content: '❌ Failed to send DM embed. The user may have DMs disabled, blocked the bot, or one of the URLs may be invalid.',
          ephemeral: true
        });
      }
      return;
    }

    // DM File command (new)
    if (commandName === 'dmfile') {
      const targetUser = interaction.options.getUser('user');
      const file = interaction.options.getAttachment('file');
      const message = interaction.options.getString('message');
      const customFilename = interaction.options.getString('filename');
      const anonymous = interaction.options.getBoolean('anonymous') || false;

      if (targetUser.id === interaction.user.id) {
        await interaction.reply({
          content: '❌ You cannot send a DM to yourself!',
          ephemeral: true
        });
        return;
      }

      if (targetUser.bot) {
        await interaction.reply({
          content: '❌ You cannot send DMs to bots!',
          ephemeral: true
        });
        return;
      }

      // Check file size (8MB limit)
      if (file.size > 8 * 1024 * 1024) {
        await interaction.reply({
          content: '❌ File is too large. Maximum size is 8MB.',
          ephemeral: true
        });
        return;
      }

      // Validate custom filename
      let fileName = file.name;
      if (customFilename) {
        const originalExtension = file.name.split('.').pop();
        const customName = customFilename.includes('.') ? customFilename : `${customFilename}.${originalExtension}`;
        fileName = customName;
      }

      try {
        let dmContent = '';
        
        if (message) {
          dmContent = message;
        }

        if (!anonymous) {
          const prefix = `**File from ${interaction.user.tag} in ${interaction.guild.name}:**`;
          dmContent = dmContent ? `${prefix}\n\n${dmContent}` : prefix;
        }

        const dmMessage = {
          content: dmContent || undefined,
          files: [{
            attachment: file.url,
            name: fileName
          }]
        };

        await targetUser.send(dmMessage);

        const fileType = file.contentType || 'Unknown';
        const embed = new EmbedBuilder()
          .setColor(0x9B59B6)
          .setTitle('✅ File Sent Successfully')
          .addFields(
            { name: 'Recipient', value: targetUser.tag, inline: true },
            { name: 'File Type', value: fileType, inline: true },
            { name: 'File Size', value: `${(file.size / 1024 / 1024).toFixed(2)} MB`, inline: true },
            { name: 'Original Name', value: file.name, inline: true },
            { name: 'Sent As', value: fileName, inline: true },
            { name: 'Anonymous', value: anonymous ? '✅ Yes' : '❌ No', inline: true }
          )
          .setFooter({ text: `File transfer completed` })
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (error) {
        console.error('DM file send error:', error);
        await interaction.reply({
          content: '❌ Failed to send DM file. The user may have DMs disabled, blocked the bot, or the file may be corrupted.',
          ephemeral: true
        });
      }
      return;
    }

    // DM Bulk command (new)
    if (commandName === 'dmbulk') {
      const userIds = interaction.options.getString('users');
      const message = interaction.options.getString('message');
      const anonymous = interaction.options.getBoolean('anonymous') || false;
      const delay = interaction.options.getInteger('delay') || 2;

      // Parse user IDs
      const userIdArray = userIds.split(',').map(id => id.trim()).filter(id => id.length > 0);
      
      if (userIdArray.length === 0) {
        await interaction.reply({
          content: '❌ No valid user IDs provided!',
          ephemeral: true
        });
        return;
      }

      if (userIdArray.length > 10) {
        await interaction.reply({
          content: '❌ Too many users! Maximum 10 users allowed for bulk messaging.',
          ephemeral: true
        });
        return;
      }

      // Check if any user ID is the command user
      if (userIdArray.includes(interaction.user.id)) {
        await interaction.reply({
          content: '❌ You cannot include yourself in bulk messaging!',
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const results = {
        success: [],
        failed: [],
        skipped: []
      };

      try {
        for (let i = 0; i < userIdArray.length; i++) {
          const userId = userIdArray[i];
          
          // Validate user ID format
          if (!/^\d{17,19}$/.test(userId)) {
            results.failed.push({ userId, reason: 'Invalid ID format' });
            continue;
          }

          try {
            const targetUser = await client.users.fetch(userId);
            
            if (targetUser.bot) {
              results.skipped.push({ userId, reason: 'Target is a bot' });
              continue;
            }

            let dmContent = message;
            if (!anonymous) {
              dmContent = `**Bulk message from ${interaction.user.tag} in ${interaction.guild.name}:**\n\n${message}`;
            }

            await targetUser.send(dmContent);
            results.success.push({ userId, username: targetUser.tag });

            // Add delay between messages (except for the last one)
            if (i < userIdArray.length - 1) {
              await new Promise(resolve => setTimeout(resolve, delay * 1000));
            }

          } catch (userError) {
            console.error(`Failed to send bulk DM to ${userId}:`, userError);
            results.failed.push({ userId, reason: 'DMs disabled or user blocked bot' });
          }
        }

        const embed = new EmbedBuilder()
          .setColor(results.success.length > 0 ? 0x00AE86 : 0xFF6B35)
          .setTitle('📬 Bulk DM Results')
          .addFields(
            { name: '✅ Successful', value: `${results.success.length} messages sent`, inline: true },
            { name: '❌ Failed', value: `${results.failed.length} messages failed`, inline: true },
            { name: '⏭️ Skipped', value: `${results.skipped.length} users skipped`, inline: true },
            { name: 'Message Length', value: `${message.length} characters`, inline: true },
            { name: 'Delay Used', value: `${delay} seconds`, inline: true },
            { name: 'Anonymous', value: anonymous ? '✅ Yes' : '❌ No', inline: true }
          );

        if (results.success.length > 0) {
          const successList = results.success.slice(0, 5).map(r => `• ${r.username}`).join('\n');
          const extraSuccess = results.success.length > 5 ? `\n... and ${results.success.length - 5} more` : '';
          embed.addFields({ name: 'Successfully Sent To', value: successList + extraSuccess, inline: false });
        }

        if (results.failed.length > 0) {
          const failedList = results.failed.slice(0, 3).map(r => `• ${r.userId}: ${r.reason}`).join('\n');
          const extraFailed = results.failed.length > 3 ? `\n... and ${results.failed.length - 3} more failures` : '';
          embed.addFields({ name: 'Failed Deliveries', value: failedList + extraFailed, inline: false });
        }

        embed.setFooter({ text: `Bulk messaging completed` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

      } catch (error) {
        console.error('Bulk DM error:', error);
        await interaction.editReply({
          content: '❌ Failed to complete bulk messaging. Please check user IDs and try again.'
        });
      }
      return;
    }

    // Auth slash command
    if (commandName === 'auth') {
      // Strict bot owner verification
      if (!isBotOwner(interaction.user.id)) {
        await interaction.reply({
          content: '❌ **Access Denied:** Only the bot owner can authenticate servers.',
          ephemeral: true
        });
        
        // Log unauthorized attempt
        console.log(`🚨 UNAUTHORIZED SLASH AUTH ATTEMPT: ${interaction.user.tag} (${interaction.user.id}) tried to authenticate server ${interaction.guild.name} (${interaction.guild.id})`);
        return;
      }

      const providedKey = interaction.options.getString('key');
      const correctKey = 'KM54928';

      // Strict key validation
      if (providedKey !== correctKey) {
        await interaction.reply({
          content: '❌ **Invalid authentication key!** Access denied.',
          ephemeral: true
        });
        
        // Log failed key attempt
        console.log(`🚨 INVALID SLASH AUTH KEY: ${interaction.user.tag} (${interaction.user.id}) used wrong key "${providedKey}" in server ${interaction.guild.name}`);
        return;
      }

      // Double verification - check both owner ID and key
      const BOT_OWNER_ID = '1327564898460242015';
      if (interaction.user.id !== BOT_OWNER_ID) {
        await interaction.reply({
          content: '❌ **Security Error:** Owner verification failed.',
          ephemeral: true
        });
        console.log(`🚨 SECURITY BREACH ATTEMPT: Non-owner ${interaction.user.tag} (${interaction.user.id}) tried slash auth with correct key`);
        return;
      }

      // Authenticate the server
      const authenticatedServers = loadAuthenticatedServers();
      authenticatedServers[interaction.guild.id] = true;
      saveAuthenticatedServers(authenticatedServers);

      // Log successful authentication
      console.log(`✅ SERVER AUTHENTICATED (SLASH): ${interaction.guild.name} (${interaction.guild.id}) by owner ${interaction.user.tag}`);

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ Server Authenticated Successfully')
        .setDescription('All bot commands are now available for use in this server!')
        .addFields(
          { name: '🏰 Server', value: interaction.guild.name, inline: true },
          { name: '👑 Authenticated by', value: `${interaction.user.tag} (VERIFIED OWNER)`, inline: true },
          { name: '🔐 Status', value: '✅ Fully Authenticated', inline: true },
          { name: '🎮 Available Commands', value: 'All slash commands and prefix commands are now active', inline: false },
          { name: '🔑 Security', value: '✅ Owner ID and key verified', inline: false }
        )
        .setFooter({ text: 'Authentication completed by Script • Security verified' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // Unauthenticate slash command
    if (commandName === 'unauthenticate') {
      // Strict bot owner verification
      if (!isBotOwner(interaction.user.id)) {
        await interaction.reply({
          content: '❌ **Access Denied:** Only the bot owner can unauthenticate servers.',
          ephemeral: true
        });
        
        // Log unauthorized attempt
        console.log(`🚨 UNAUTHORIZED SLASH UNAUTH ATTEMPT: ${interaction.user.tag} (${interaction.user.id}) tried to unauthenticate server ${interaction.guild.name} (${interaction.guild.id})`);
        return;
      }

      const providedKey = interaction.options.getString('key');
      const correctKey = 'KM54928';

      // Strict key validation
      if (providedKey !== correctKey) {
        await interaction.reply({
          content: '❌ **Invalid authentication key!** Access denied.',
          ephemeral: true
        });
        
        // Log failed key attempt
        console.log(`🚨 INVALID SLASH UNAUTH KEY: ${interaction.user.tag} (${interaction.user.id}) used wrong key "${providedKey}" in server ${interaction.guild.name}`);
        return;
      }

      // Double verification - check both owner ID and key
      const BOT_OWNER_ID = '1327564898460242015';
      if (interaction.user.id !== BOT_OWNER_ID) {
        await interaction.reply({
          content: '❌ **Security Error:** Owner verification failed.',
          ephemeral: true
        });
        console.log(`🚨 SECURITY BREACH ATTEMPT: Non-owner ${interaction.user.tag} (${interaction.user.id}) tried slash unauth with correct key`);
        return;
      }

      // Remove authentication from the server
      const authenticatedServers = loadAuthenticatedServers();
      delete authenticatedServers[interaction.guild.id];
      saveAuthenticatedServers(authenticatedServers);

      // Log successful unauthentication
      console.log(`🔒 SERVER UNAUTHENTICATED (SLASH): ${interaction.guild.name} (${interaction.guild.id}) by owner ${interaction.user.tag}`);

      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🔒 Server Authentication Cancelled')
        .setDescription('All bot commands are now blocked in this server!')
        .addFields(
          { name: '🏰 Server', value: interaction.guild.name, inline: true },
          { name: '👑 Unauthenticated by', value: `${interaction.user.tag} (VERIFIED OWNER)`, inline: true },
          { name: '🔐 Status', value: '❌ Authentication Removed', inline: true },
          { name: '🚫 Command Access', value: 'All commands now show "Authentication Required from Script"', inline: false },
          { name: '🔑 Re-authentication', value: 'Use `/auth key:KM54928` to re-enable commands', inline: false },
          { name: '🔑 Security', value: '✅ Owner ID and key verified', inline: false }
        )
        .setFooter({ text: 'Authentication cancelled by Script • Security verified' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

  } catch (error) {
    console.error('Command error:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ An error occurred while processing your command.',
          ephemeral: true
        });
      }
    } catch (replyError) {
      console.error('Failed to reply with error message:', replyError);
    }
  }
});

// Enhanced message handling for text extraction and AI chat
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  try {
    if (allowed_channel_ids.length > 0 && !allowed_channel_ids.includes(message.channel.id)) {
      return;
    }

    if (!checkCooldown(message.author.id, true)) {
      return;
    }

    // Handle prefix commands
    if (message.content.startsWith(BOT_PREFIX)) {
      await handlePrefixCommand(message);
      return;
    }

    // Handle bot mentions with re-tagging and DM notification
    if (message.mentions.has(client.user)) {
      try {
        // Check authentication for bot mentions
        if (!isServerAuthenticated(message.guild.id)) {
          await message.reply('**Authentication Required from Script**');
          return;
        }
        // Send DM notification to bot owner
        const botOwner = await client.users.fetch('1327564898460242015').catch(() => null);
        if (botOwner) {
          try {
            const dmEmbed = new EmbedBuilder()
              .setColor(0x1DB954)
              .setTitle('🔔 Bot Mentioned')
              .setDescription(`You were mentioned in a server!`)
              .addFields(
                { name: '👤 User', value: `${message.author.tag} (${message.author.id})`, inline: true },
                { name: '🏰 Server', value: `${message.guild.name}`, inline: true },
                { name: '📍 Channel', value: `#${message.channel.name}`, inline: true },
                { name: '💬 Message', value: message.content.length > 500 ? message.content.substring(0, 500) + '...' : message.content, inline: false },
                { name: '🔗 Jump to Message', value: `[Click here](${message.url})`, inline: false }
              )
              .setThumbnail(message.author.displayAvatarURL())
              .setTimestamp();

            await botOwner.send({ embeds: [dmEmbed] });
          } catch (dmError) {
            console.error('Failed to send mention DM to owner:', dmError);
          }
        }

        const content = message.content.replace(/<@!?\d+>/g, '').trim();
        
        if (content.length > 0) {
          const response = await getAIResponse(content, true, false);
          
          if (response && response.length > 10) {
            let reply = response;
            if (reply.length > 1900) {
              reply = reply.substring(0, 1900) + "...";
            }
            await message.reply(`<@${message.author.id}> ${reply}`);
          } else {
            await message.reply(`<@${message.author.id}> I'm here to help! What would you like to know? 🤖⚡`);
          }
        } else {
          await message.reply(`<@${message.author.id}> Hello! How can I assist you today? 🤖⚡`);
        }
      } catch (error) {
        console.error('Error replying to mention:', error);
        try {
          await message.reply(`${message.author} I'm here to help! 🤖⚡`);
        } catch (fallbackError) {
          console.error('Fallback mention reply failed:', fallbackError);
        }
      }
      return;
    }

    // Handle image text extraction
    if (image2textChannels.includes(message.channel.id) && message.attachments.size > 0) {
      const attachment = message.attachments.first();
      if (attachment && attachment.contentType && attachment.contentType.startsWith('image/')) {
        try {
          const extractedText = await extractTextFromImage(attachment.url);
          await safeReply(message, `📝 **Text extracted from image:**\n\`\`\`${extractedText}\`\`\``);
        } catch (error) {
          console.error('Image processing error:', error);
          await safeReply(message, "❌ Sorry, I couldn't extract text from that image.");
        }
      }
      return;
    }

    // Handle AI conversation with enhanced caching and user re-tagging
    if (message.content && message.content.length > 2 && !message.content.startsWith('/') && !message.content.startsWith('!')) {
      try {
        // Check authentication for AI chat
        if (!isServerAuthenticated(message.guild.id)) {
          return; // Silently ignore AI chat if not authenticated
        }
        const cleanContent = message.content.trim();
        await message.channel.sendTyping();

        const response = await getAIResponse(cleanContent, true, false);

        if (response && response.length > 5) {
          let reply = response;

          if (reply.length > 1900) {
            reply = reply.substring(0, 1900) + "...";
          }

          await safeReply(message, `<@${message.author.id}> ${reply}`);
        } else {
          // Always provide a response instead of staying silent
          const contextualResponses = [
            "🤔 That's an interesting point! Tell me more about it.",
            "💭 I'm thinking about what you said. Could you elaborate?",
            "🔄 I'm processing your message. What specific aspect interests you most?",
            "💬 That's a good question! What would you like to know specifically?",
            "⚡ I'm here to help! Can you provide more details about what you're looking for?"
          ];
          const contextualResponse = contextualResponses[Math.floor(Math.random() * contextualResponses.length)];
          try {
            await safeReply(message, `<@${message.author.id}> ${contextualResponse}`);
          } catch (fallbackError) {
            console.error('Contextual response failed:', fallbackError);
          }
        }
      } catch (error) {
        console.error('AI response error:', error.message);
        
        // Provide helpful error responses
        const errorResponses = [
          "🤖 I'm having a small technical hiccup, but I'm here to help! Try asking again.",
          "💭 Something went wrong on my end. Please give me another try!",
          "🔄 I encountered a temporary issue. Your message is important - ask me again!",
          "💬 Technical glitch detected! But I'm still here to assist you.",
          "⚡ I'm experiencing some difficulties right now. Please try again!"
        ];
        const errorResponse = errorResponses[Math.floor(Math.random() * errorResponses.length)];
        try {
          await safeReply(message, `<@${message.author.id}> ${errorResponse}`);
        } catch (fallbackError) {
          console.error('Error response failed:', fallbackError);
        }
      }
    }

  } catch (error) {
    console.error('Message handling error:', error);
  }
});

// Anti-nuke event listeners (kept for security)
client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  try {
    const auditLogs = await channel.guild.fetchAuditLogs({ type: 12, limit: 1 });
    const deleteLog = auditLogs.entries.first();
    if (deleteLog) {
      checkAntiNuke(channel.guild, deleteLog.executor.id, 'channelDeletes', antiNukeConfig.maxChannelDeletes);
    }
  } catch (error) {
    console.error('Anti-nuke channel delete error:', error);
  }
});

client.on('roleDelete', async (role) => {
  try {
    const auditLogs = await role.guild.fetchAuditLogs({ type: 32, limit: 1 });
    const deleteLog = auditLogs.entries.first();
    if (deleteLog) {
      checkAntiNuke(role.guild, deleteLog.executor.id, 'roleDeletes', antiNukeConfig.maxRoleDeletes);
    }
  } catch (error) {
    console.error('Anti-nuke role delete error:', error);
  }
});

client.on('guildBanAdd', async (ban) => {
  try {
    const auditLogs = await ban.guild.fetchAuditLogs({ type: 22, limit: 1 });
    const banLog = auditLogs.entries.first();
    if (banLog && banLog.target.id === ban.user.id) {
      checkAntiNuke(ban.guild, banLog.executor.id, 'bans', antiNukeConfig.maxBans);
    }
  } catch (error) {
    console.error('Anti-nuke ban error:', error);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    const auditLogs = await member.guild.fetchAuditLogs({ type: 20, limit: 1 });
    const kickLog = auditLogs.entries.first();
    if (kickLog && kickLog.target.id === member.id && kickLog.createdTimestamp > Date.now() - 5000) {
      checkAntiNuke(member.guild, kickLog.executor.id, 'kicks', antiNukeConfig.maxKicks);
    }
  } catch (error) {
    console.error('Anti-nuke kick error:', error);
  }
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  try {
    const auditLogs = await channel.guild.fetchAuditLogs({ type: 10, limit: 1 });
    const createLog = auditLogs.entries.first();
    if (createLog) {
      checkAntiNuke(channel.guild, createLog.executor.id, 'channelCreates', antiNukeConfig.maxChannelCreates);
    }
  } catch (error) {
    console.error('Anti-nuke channel create error:', error);
  }
});

client.on('roleCreate', async (role) => {
  try {
    const auditLogs = await role.guild.fetchAuditLogs({ type: 30, limit: 1 });
    const createLog = auditLogs.entries.first();
    if (createLog) {
      checkAntiNuke(role.guild, createLog.executor.id, 'roleCreates', antiNukeConfig.maxRoleCreates);
    }
  } catch (error) {
    console.error('Anti-nuke role create error:', error);
  }
});

client.on('guildMemberAdd', async (member) => {
  if (!member.user.bot) return;
  try {
    const auditLogs = await member.guild.fetchAuditLogs({ type: 28, limit: 1 });
    const botAddLog = auditLogs.entries.first();
    if (botAddLog && botAddLog.target.id === member.id) {
      const executor = member.guild.members.cache.get(botAddLog.executor.id);
      if (executor && !isWhitelisted(executor)) {
        try {
          await member.kick('Anti-nuke: Unauthorized bot addition');
          if (antiNukeConfig.logChannelId) {
            const logChannel = member.guild.channels.cache.get(antiNukeConfig.logChannelId);
            if (logChannel) {
              const embed = new EmbedBuilder()
                .setColor(0xFF6600)
                .setTitle('🤖 Unauthorized Bot Removed')
                .addFields(
                  { name: 'Bot', value: `${member.user.tag} (${member.id})`, inline: true },
                  { name: 'Added By', value: `${botAddLog.executor.tag} (${botAddLog.executor.id})`, inline: true },
                  { name: 'Action', value: 'Bot kicked automatically', inline: true }
                )
                .setTimestamp();
              await logChannel.send({ embeds: [embed] });
            }
          }
        } catch (error) {
          console.error('Failed to kick unauthorized bot:', error);
        }
      }
    }
  } catch (error) {
    console.error('Anti-nuke bot add error:', error);
  }
});

// Enhanced auto-restart system for 24/7 operation
const AUTO_RESTART_CONFIG = {
  enabled: true,
  maxMemoryMB: 280,
  maxUptimeHours: 20,
  healthCheckInterval: 5000, // 5 seconds
  emergencyRestartInterval: 3000, // 3 seconds
  connectionCheckInterval: 8000, // 8 seconds
  statusReportInterval: 10 * 60 * 1000 // 10 minutes
};

// Auto-restart health monitoring
let healthCheckCount = 0;
let lastSuccessfulHealthCheck = Date.now();
let autoRestartStats = {
  totalRestarts: 0,
  lastRestartTime: null,
  lastRestartReason: null,
  uptimeStart: Date.now()
};

// Load restart stats from previous session if available
try {
  const fs = require('fs');
  if (fs.existsSync('./restart-stats.json')) {
    const savedStats = JSON.parse(fs.readFileSync('./restart-stats.json', 'utf8'));
    autoRestartStats.totalRestarts = savedStats.totalRestarts || 0;
    autoRestartStats.lastRestartTime = savedStats.lastRestartTime;
    autoRestartStats.lastRestartReason = savedStats.lastRestartReason;
  }
} catch (error) {
  console.log('⚠️ Could not load restart stats:', error.message);
}

// Save restart stats function
function saveRestartStats() {
  try {
    const fs = require('fs');
    fs.writeFileSync('./restart-stats.json', JSON.stringify(autoRestartStats, null, 2));
  } catch (error) {
    console.error('❌ Failed to save restart stats:', error.message);
  }
}

// Auto-restart function
function performAutoRestart(reason) {
  try {
    autoRestartStats.totalRestarts++;
    autoRestartStats.lastRestartTime = Date.now();
    autoRestartStats.lastRestartReason = reason;
    saveRestartStats();
    
    console.log(`🔄 AUTO-RESTART INITIATED: ${reason}`);
    console.log(`📊 Total restarts: ${autoRestartStats.totalRestarts}`);
    console.log(`⏰ Uptime before restart: ${Math.round((Date.now() - autoRestartStats.uptimeStart) / 1000 / 60)} minutes`);
    
    // Cleanup before restart
    if (uptimeMonitor) {
      uptimeMonitor.cleanup();
    }
    if (keepAliveService) {
      keepAliveService.stop();
    }
    
    // Clear intervals
    if (client.vcMoveIntervals) {
      client.vcMoveIntervals.clear();
    }
    
    // Exit gracefully - Replit will auto-restart
    setTimeout(() => {
      console.log('🚀 Restarting for 24/7 operation...');
      process.exit(0);
    }, 1000);
    
  } catch (error) {
    console.error('❌ Auto-restart function failed:', error.message);
    process.exit(0);
  }
}

// Enhanced health check system
function performEnhancedHealthCheck() {
  try {
    healthCheckCount++;
    const currentTime = Date.now();
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
    const uptimeHours = (currentTime - autoRestartStats.uptimeStart) / (1000 * 60 * 60);
    
    // Memory threshold check
    if (heapUsedMB > AUTO_RESTART_CONFIG.maxMemoryMB) {
      performAutoRestart(`Memory threshold exceeded: ${heapUsedMB.toFixed(2)}MB > ${AUTO_RESTART_CONFIG.maxMemoryMB}MB`);
      return;
    }
    
    // Uptime threshold check for fresh restart
    if (uptimeHours > AUTO_RESTART_CONFIG.maxUptimeHours) {
      performAutoRestart(`Scheduled restart: Uptime ${uptimeHours.toFixed(2)} hours > ${AUTO_RESTART_CONFIG.maxUptimeHours} hours`);
      return;
    }
    
    // Bot connection check
    if (!client.readyAt || client.ws.status !== 0) {
      performAutoRestart('Bot connection lost - Discord API disconnected');
      return;
    }
    
    // Health check success
    lastSuccessfulHealthCheck = currentTime;
    
    // Log periodic health status
    if (healthCheckCount % 120 === 0) { // Every 10 minutes (5s * 120)
      console.log(`💚 Health Check #${healthCheckCount}: Memory ${heapUsedMB.toFixed(2)}MB, Uptime ${uptimeHours.toFixed(2)}h, Status OK`);
    }
    
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    performAutoRestart('Health check system failure');
  }
}

// Emergency restart monitoring (more aggressive)
function performEmergencyCheck() {
  try {
    const currentTime = Date.now();
    const timeSinceLastHealthCheck = currentTime - lastSuccessfulHealthCheck;
    
    // Emergency restart if health checks have been failing
    if (timeSinceLastHealthCheck > 30000) { // 30 seconds without successful health check
      performAutoRestart('Emergency: No successful health check in 30 seconds');
      return;
    }
    
    // Critical memory check
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
    if (heapUsedMB > 350) { // Critical threshold
      performAutoRestart(`Emergency: Critical memory usage ${heapUsedMB.toFixed(2)}MB`);
      return;
    }
    
    // Check for excessive error listeners
    if (process.listenerCount('unhandledRejection') > 15) {
      performAutoRestart('Emergency: Too many error listeners detected');
      return;
    }
    
  } catch (error) {
    console.error('❌ Emergency check failed:', error.message);
    performAutoRestart('Emergency check system failure');
  }
}

// Enhanced error handling for 24/7 operation
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't restart immediately for single rejections, let health checks handle it
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  performAutoRestart(`Uncaught Exception: ${error.message}`);
});

// Graceful shutdown handlers
process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, performing graceful restart...');
  performAutoRestart('Manual restart via SIGINT');
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, performing graceful restart...');
  performAutoRestart('System restart via SIGTERM');
});

// Discord client event handlers for auto-restart
client.on('disconnect', () => {
  console.log('🔌 Bot disconnected, will auto-restart if connection not restored');
  setTimeout(() => {
    if (!client.readyAt || client.ws.status !== 0) {
      performAutoRestart('Discord connection lost and not restored');
    }
  }, 15000); // Wait 15 seconds for auto-reconnect
});

client.on('reconnecting', () => {
  console.log('🔄 Bot reconnecting...');
});

client.on('error', (error) => {
  console.error('Client error:', error);
  if (error.code === 'TOKEN_INVALID' || error.code === 'DISALLOWED_INTENTS') {
    performAutoRestart(`Critical Discord error: ${error.code}`);
  }
});

client.on('warn', (warning) => {
  console.warn('Client warning:', warning);
});

// Start auto-restart monitoring system
if (AUTO_RESTART_CONFIG.enabled) {
  // Health check every 5 seconds
  setInterval(performEnhancedHealthCheck, AUTO_RESTART_CONFIG.healthCheckInterval);
  
  // Emergency check every 3 seconds
  setInterval(performEmergencyCheck, AUTO_RESTART_CONFIG.emergencyRestartInterval);
  
  // Connection verification every 8 seconds
  setInterval(() => {
    if (!client.readyAt) {
      console.log('⚠️ Bot not ready, checking connection...');
    }
  }, AUTO_RESTART_CONFIG.connectionCheckInterval);
  
  // Status report every 10 minutes
  setInterval(() => {
    const uptimeMinutes = Math.round((Date.now() - autoRestartStats.uptimeStart) / 1000 / 60);
    const memoryMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`🤖 24/7 Status: Uptime ${uptimeMinutes}m | Memory ${memoryMB}MB | Total Restarts ${autoRestartStats.totalRestarts} | Health Checks ${healthCheckCount}`);
  }, AUTO_RESTART_CONFIG.statusReportInterval);
  
  console.log('🚀 24/7 Auto-restart system activated');
  console.log(`📊 Previous session stats: ${autoRestartStats.totalRestarts} total restarts`);
  if (autoRestartStats.lastRestartTime) {
    const timeSinceLastRestart = Math.round((Date.now() - autoRestartStats.lastRestartTime) / 1000 / 60);
    console.log(`⏰ Last restart: ${timeSinceLastRestart} minutes ago (${autoRestartStats.lastRestartReason})`);
  }
}

// Enhanced startup with retry logic
async function startBot(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      startServer();
      await client.login(process.env.TOKEN);
      console.log('✅ Bot started successfully with enhanced features!');
      break;
    } catch (error) {
      console.error(`❌ Failed to start bot (attempt ${i + 1}/${retries}):`, error);
      if (i === retries - 1) {
        console.error('❌ Failed to start bot after all retries');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, 5000 * (i + 1)));
    }
  }
}

if (!process.env.TOKEN) {
  console.error('❌ No bot token provided. Please set the TOKEN environment variable.');
  process.exit(1);
}

startBot();