const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, getVoiceConnection } = require("@discordjs/voice");
const { Hercai } = require("hercai");
const Tesseract = require("tesseract.js");
const fetch = require("node-fetch");
const { startServer } = require("./alive.js");
const LocalMusicPlayer = require("./music-player.js");
const UptimeMonitor = require("./uptime-monitor.js");
const KeepAliveService = require("./keep-alive-service.js");
require("dotenv").config();



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

const herc = new Hercai();

// Rate limiting - Reduced cooldowns for faster responses
const userCooldowns = new Map();
const COOLDOWN_TIME = 1000;
const AI_COOLDOWN_TIME = 2000;
const developerCommandCooldowns = new Map();
const DEVELOPER_COOLDOWN_TIME = 24 * 60 * 60 * 1000;

// Response cache for faster AI responses
const responseCache = new Map();
const MAX_CACHE_SIZE = 500;
const CACHE_EXPIRE_TIME = 10 * 60 * 1000; // 10 minutes

// Music player storage
const musicQueues = new Map();
const voiceConnections = new Map();
const localMusicPlayers = new Map();
let uptimeMonitor = null;
let keepAliveService = null;

// Anti-nuke system
const antiNukeConfig = {
  enabled: true,
  maxChannelDeletes: 3,
  maxRoleDeletes: 3,
  maxBans: 5,
  maxKicks: 5,
  maxChannelCreates: 5,
  maxRoleCreates: 5,
  timeWindow: 60000,
  punishmentType: 'ban',
  whitelistedUsers: [],
  whitelistedRoles: [],
  logChannelId: null
};

const antiNukeData = {
  channelDeletes: new Map(),
  roleDeletes: new Map(),
  bans: new Map(),
  kicks: new Map(),
  channelCreates: new Map(),
  roleCreates: new Map(),
  memberUpdates: new Map()
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

  if (recentActions.length > limit) {
    punishUser(guild, member, action, recentActions.length);
    return true;
  }
  return false;
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

// Enhanced cache management
function cleanCache() {
  const now = Date.now();
  for (const [key, data] of responseCache.entries()) {
    if (now - data.timestamp > CACHE_EXPIRE_TIME) {
      responseCache.delete(key);
    }
  }
  if (responseCache.size > MAX_CACHE_SIZE) {
    const keysToDelete = Array.from(responseCache.keys()).slice(0, responseCache.size - MAX_CACHE_SIZE);
    keysToDelete.forEach(key => responseCache.delete(key));
  }
}

setInterval(cleanCache, 5 * 60 * 1000);

// Prefix command handler
async function handlePrefixCommand(message) {
  try {
    if (!checkCooldown(message.author.id)) {
      return;
    }

    const args = message.content.slice(BOT_PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
      case 'ping':
        await handlePingCommand(message);
        break;
      
      case 'help':
        await handleHelpCommand(message);
        break;
      
      case 'chat':
      case 'ai':
        await handleChatCommand(message, args);
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
      
      case 'advice':
        await handleAdviceCommand(message, args);
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
        name: '🎨 AI & Fun Commands',
        value: `• \`${BOT_PREFIX}image <prompt>\` - Generate AI images\n• \`${BOT_PREFIX}gif [search]\` - Send random GIFs\n• \`${BOT_PREFIX}chat <message>\` - Chat with AI\n• \`${BOT_PREFIX}say <message>\` - Make bot say something\n• \`${BOT_PREFIX}compliment\` - Get a compliment\n• \`${BOT_PREFIX}advice [topic]\` - Get advice\n• \`${BOT_PREFIX}ping\` - Check bot latency`,
        inline: false
      },
      {
        name: '📊 Information Commands',
        value: `• \`${BOT_PREFIX}userinfo [user]\` - User information\n• \`${BOT_PREFIX}serverinfo\` - Server information\n• \`${BOT_PREFIX}uptime\` - Bot uptime stats\n• \`${BOT_PREFIX}developer\` - Developer info\n• \`${BOT_PREFIX}help\` - Show this menu`,
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

async function handleChatCommand(message, args) {
  if (args.length === 0) {
    await message.reply(`❌ Please provide a message! Usage: \`${BOT_PREFIX}chat <your message>\``);
    return;
  }

  if (!checkCooldown(message.author.id, true)) {
    await message.reply('⏰ Please wait before using AI commands again.');
    return;
  }

  const userMessage = args.join(' ');
  
  try {
    await message.channel.sendTyping();
    const response = await getAIResponse(userMessage, true);

    if (response && response.length > 5) {
      let reply = response;
      if (reply.length > 1900) {
        reply = reply.substring(0, 1900) + "...";
      }
      await message.reply(`${message.author} ${reply}`);
    } else {
      const fallbackResponses = [
        "I received your message! Could you try rephrasing your question?",
        "That's an interesting topic! Tell me more about it.",
        "I'm processing your request. What else would you like to know?",
        "I'm here to help! What specific information do you need?"
      ];
      const randomFallback = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
      await message.reply(`${message.author} ${randomFallback}`);
    }
  } catch (error) {
    console.error('Chat command error:', error);
    await message.reply(`${message.author} I'm having trouble right now, but I'm here to help! Please try again.`);
  }
}

async function handleImageCommand(message, args) {
  if (args.length === 0) {
    await message.reply(`❌ Please provide a prompt! Usage: \`${BOT_PREFIX}image <your prompt>\``);
    return;
  }

  const prompt = args.join(' ');
  const loadingMessage = await message.reply('🎨 Generating your image...');

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

      await loadingMessage.edit({ content: '', embeds: [embed] });
    } else {
      await loadingMessage.edit(`❌ ${message.author}, failed to generate image. Please try again with a different prompt!`);
    }
  } catch (error) {
    console.error('Image command error:', error);
    await loadingMessage.edit(`❌ ${message.author}, image generation failed. Please try again later!`);
  }
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

async function handleAdviceCommand(message, args) {
  const topic = args.length > 0 ? args.join(' ') : 'life';

  try {
    await message.channel.sendTyping();
    const response = await getAIResponse(`Give friendly, helpful advice about ${topic}. Keep it concise and positive.`, false);

    if (response) {
      await message.reply(`💡 **Advice about ${topic}:**\n\n${response}`);
    } else {
      await message.reply("💡 Here's some general advice: Take things one step at a time, be kind to yourself, and remember that every challenge is an opportunity to grow! 🌱");
    }
  } catch (error) {
    console.error('Advice command error:', error);
    await message.reply("💡 Here's some general advice: Take things one step at a time, be kind to yourself, and remember that every challenge is an opportunity to grow! 🌱");
  }
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
      { name: '🌐 Support Server', value: '[discord.gg/scriptspace](https://discord.gg/scriptspace)', inline: true },
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

// Enhanced AI response function with better error handling
async function getAIResponse(content, useCache = true) {
  const cacheKey = content.toLowerCase().trim();

  if (useCache && responseCache.has(cacheKey)) {
    const cached = responseCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_EXPIRE_TIME) {
      return cached.response;
    }
  }

  try {
    const codeKeywords = [
      'code', 'script', 'function', 'program', 'algorithm', 'implementation',
      'how to code', 'write code', 'create a', 'build a', 'make a',
      'javascript', 'python', 'html', 'css', 'java', 'c++', 'c#',
      'react', 'node', 'discord bot', 'api', 'database', 'sql',
      'example code', 'code example', 'snippet', 'tutorial'
    ];

    const isCodeRequest = codeKeywords.some(keyword => 
      content.toLowerCase().includes(keyword)
    );

    let enhancedPrompt;
    
    if (isCodeRequest) {
      enhancedPrompt = `You are a helpful programming assistant Discord bot. The user is asking for code help: "${content}". 

      Please provide:
      1. A brief explanation
      2. Working code example with proper syntax highlighting (use \`\`\`language format)
      3. Brief explanation of how the code works
      
      Keep response under 1500 characters. Focus on practical, working code examples.`;
    } else {
      enhancedPrompt = `You are a helpful Discord bot assistant. Respond naturally and concisely to: "${content}". Keep it under 200 words and be friendly.`;
    }

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), 12000)
    );

    const responsePromise = herc.question({
      model: "v3",
      content: enhancedPrompt
    });

    const response = await Promise.race([responsePromise, timeoutPromise]);

    if (response && response.reply && response.reply.trim()) {
      let result = response.reply.trim();

      // Clean up common AI artifacts
      result = result.replace(/^(Assistant|Bot|AI):\s*/gi, '');
      result = result.replace(/^(Here's|Here is)\s+/gi, '');
      
      if (isCodeRequest && !result.includes('```')) {
        const lines = result.split('\n');
        let inCodeBlock = false;
        const formattedLines = lines.map(line => {
          if (line.includes('function') || line.includes('def ') || line.includes('class ') || 
              line.includes('import ') || line.includes('const ') || line.includes('let ') ||
              line.includes('var ') || line.includes('if (') || line.includes('for (')) {
            if (!inCodeBlock) {
              inCodeBlock = true;
              return '```javascript\n' + line;
            }
            return line;
          } else if (inCodeBlock && (line.trim() === '' || line.match(/^[a-zA-Z]/))) {
            inCodeBlock = false;
            return '```\n' + line;
          }
          return line;
        });
        
        if (inCodeBlock) {
          formattedLines.push('```');
        }
        
        result = formattedLines.join('\n');
      }

      if (useCache) {
        responseCache.set(cacheKey, {
          response: result,
          timestamp: Date.now()
        });
      }

      return result;
    }

    // Return fallback response instead of null
    const fallbackResponses = [
      "I'm here to help! Could you rephrase that question?",
      "That's interesting! Tell me more about what you're looking for.",
      "I'm processing your request. What specific information do you need?",
      "Great question! Could you provide a bit more detail?",
      "I'd love to help with that! Can you be more specific?"
    ];
    
    return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];

  } catch (error) {
    console.error('AI Response Error:', error.message);
    
    // Return contextual fallback based on error type
    if (error.message.includes('timeout')) {
      return "I'm thinking... sometimes I need a moment to process complex questions. Try asking again!";
    } else if (error.message.includes('rate limit') || error.message.includes('quota')) {
      return "I'm getting a lot of questions right now! Please try again in a moment.";
    } else {
      const errorFallbacks = [
        "I'm having a small technical hiccup, but I'm here to help! Try rephrasing your question.",
        "Something went wrong on my end, but don't worry! Ask me again and I'll do my best.",
        "Oops! I encountered an issue. Please try your question again.",
        "I'm experiencing some difficulties right now. Please give me another try!",
        "Technical glitch detected! But I'm still here to assist you - try again!"
      ];
      return errorFallbacks[Math.floor(Math.random() * errorFallbacks.length)];
    }
  }
}

// Enhanced image generation
async function generateImage(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`🎨 Image generation attempt ${i + 1}/${retries} for prompt: "${prompt}"`);
      
      const cleanPrompt = prompt.trim().substring(0, 500);
      const enhancedPrompt = `High quality, detailed, masterpiece: ${cleanPrompt}`;

      const response = await Promise.race([
        herc.drawImage({
          model: "v3",
          prompt: enhancedPrompt,
          negative_prompt: "low quality, blurry, distorted, watermark, nsfw, inappropriate"
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout after 15 seconds')), 15000))
      ]);

      if (response && response.url) {
        console.log(`✅ Generated image URL: ${response.url}`);
        
        try {
          const testResponse = await fetch(response.url, { 
            method: 'HEAD', 
            timeout: 8000,
            headers: {
              'User-Agent': 'Discord-Bot/1.0'
            }
          });
          
          if (testResponse.ok && testResponse.headers.get('content-type')?.startsWith('image/')) {
            console.log(`✅ Image URL validated successfully`);
            return response.url;
          } else {
            console.log(`❌ Invalid image response: ${testResponse.status}`);
          }
        } catch (validateError) {
          console.error(`❌ Image validation failed:`, validateError.message);
        }
      } else {
        console.log(`❌ No valid response or URL from API`);
      }
    } catch (error) {
      console.error(`❌ Image generation attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) {
        console.error(`❌ All ${retries} attempts failed for prompt: "${prompt}"`);
        throw error;
      }
      const delay = 2000 * (i + 1);
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.error(`❌ Image generation completely failed after ${retries} attempts`);
  return null;
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
    .setName('chat')
    .setDescription('Have a conversation with me!')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('What would you like to talk about?')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('compliment')
    .setDescription('Get a sweet compliment! 💕'),
  new SlashCommandBuilder()
    .setName('advice')
    .setDescription('Get some friendly advice')
    .addStringOption(option =>
      option.setName('topic')
        .setDescription('What do you need advice about?')
        .setRequired(false)),
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
    .setName('localaddtoplaylist')
    .setDescription('Add a track to a custom playlist')
    .addStringOption(option =>
      option.setName('playlist')
        .setDescription('Name of the playlist to add to')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('search')
        .setDescription('Search term to find specific tracks (optional)')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('track')
        .setDescription('Track number from current playlist to add (optional)')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('localcustomplay')
    .setDescription('Play your custom playlists')
    .addStringOption(option =>
      option.setName('playlist')
        .setDescription('Name of your custom playlist to play')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('shuffle')
        .setDescription('Enable shuffle mode')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('loop')
        .setDescription('Enable loop mode for continuous playback')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('localcustomlist')
    .setDescription('View all your custom playlists'),
  new SlashCommandBuilder()
    .setName('localcustomnowplaying')
    .setDescription('Show enhanced custom local music player now playing widget'),

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
];

// Enhanced GIF API
async function getRandomGif(searchTerm = "funny", contentFilter = "medium") {
  try {
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

// Enhanced OCR functionality
const ocrCache = new Map();
const MAX_OCR_CACHE_SIZE = 100;

async function extractTextFromImage(url) {
  try {
    if (ocrCache.has(url)) {
      console.log('Using cached OCR result');
      return ocrCache.get(url);
    }

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

function checkCooldown(userId, isAIRequest = false) {
  const now = Date.now();
  const cooldownKey = isAIRequest ? `ai_${userId}` : userId;
  const cooldownTime = isAIRequest ? AI_COOLDOWN_TIME : COOLDOWN_TIME;
  const lastRequest = userCooldowns.get(cooldownKey);

  if (lastRequest && (now - lastRequest) < cooldownTime) {
    return false;
  }

  userCooldowns.set(cooldownKey, now);
  return true;
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
              const audioResource = createAudioResource(player.getCurrentTrack().path, {
                metadata: { title: player.getCurrentTrack().name }
              });
              if (audioResource.volume) {
                audioResource.volume.setVolume(player.volume / 100);
              }
              audioPlayer.play(audioResource);
              player.isPlaying = true;
              player.isPaused = false;
              await interaction.update({ embeds: [player.getNowPlayingWidget().embeds[0]], components: player.getNowPlayingWidget().components });
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
              const audioResource = createAudioResource(player.getCurrentTrack().path, {
                metadata: { title: player.getCurrentTrack().name }
              });
              if (audioResource.volume) {
                audioResource.volume.setVolume(player.volume / 100);
              }
              audioPlayer.play(audioResource);
              player.isPlaying = true;
              player.isPaused = false;
              await interaction.update({ embeds: [player.getNowPlayingWidget().embeds[0]], components: player.getNowPlayingWidget().components });
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
            player.toggleLoop();
            await interaction.update({ embeds: [player.getNowPlayingWidget().embeds[0]], components: player.getNowPlayingWidget().components });
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

          default:
            await interaction.reply({ content: '❌ Unknown button interaction!', ephemeral: true });
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
    if (!checkCooldown(interaction.user.id)) {
      await interaction.reply({
        content: '⏰ Please wait a moment before using another command.',
        ephemeral: true
      });
      return;
    }

    // Chat command
    if (commandName === 'chat') {
      await interaction.deferReply();
      const userMessage = interaction.options.getString('message');

      try {
        const response = await getAIResponse(userMessage, true);

        if (response && response.length > 5) {
          let reply = response;
          if (reply.length > 1900) {
            reply = reply.substring(0, 1900) + "...";
          }
          await interaction.editReply(`${interaction.user} ${reply}`);
        } else {
          const fallbackResponses = [
            "🤖 I received your message! Could you try rephrasing your question?",
            "💭 That's an interesting topic! Tell me more about it.",
            "🔄 I'm processing your request. What else would you like to know?",
            "💬 I'm here to help! What specific information do you need?"
          ];
          const randomFallback = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
          await interaction.editReply(`${interaction.user} ${randomFallback}`);
        }
      } catch (error) {
        console.error('Chat command error:', error.message);
        const errorResponses = [
          "🤖 I'm having trouble right now, but I'm here to help! Please try again.",
          "💭 Something went wrong, but don't worry! Ask me again and I'll do my best.",
          "🔄 I encountered a small hiccup. Please try your question again!",
          "💬 Technical glitch detected! But I'm still here to assist you - try again!"
        ];
        const randomError = errorResponses[Math.floor(Math.random() * errorResponses.length)];
        await interaction.editReply(randomError);
      }
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

    // Advice command
    if (commandName === 'advice') {
      await interaction.deferReply();
      const topic = interaction.options.getString('topic') || 'life';

      try {
        const response = await getAIResponse(`Give friendly, helpful advice about ${topic}. Keep it concise and positive.`, false);

        if (response) {
          await interaction.editReply(`💡 **Advice about ${topic}:**\n\n${response}`);
        } else {
          await interaction.editReply("💡 Here's some general advice: Take things one step at a time, be kind to yourself, and remember that every challenge is an opportunity to grow! 🌱");
        }
      } catch (error) {
        console.error('Advice command error:', error);
        await interaction.editReply("💡 Here's some general advice: Take things one step at a time, be kind to yourself, and remember that every challenge is an opportunity to grow! 🌱");
      }
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
              name: '🎨 AI & Fun Commands',
              value: '• `/imageprompt <prompt>` - Generate AI images\n• `/gif [search]` - Send random GIFs\n• `/chat <message>` - Chat with AI assistant\n• `/say <message>` - Make bot say something (supports media!)\n• `/greet <user>` - Greet a user with customizable styles\n• `/compliment` - Get a sweet compliment\n• `/advice [topic]` - Get friendly advice\n• `/ping` - Check bot latency',
              inline: false
            },
            
            {
              name: '🎵 Local Music Commands',
              value: '• `/localplay [search] [track]` - Play local music\n• `/localpause` - Pause/resume playback\n• `/localnext` - Next track\n• `/localprevious` - Previous track\n• `/localvolume set/up/down` - Control volume\n• `/localloop` - Toggle loop mode\n• `/localshuffle` - Toggle shuffle\n• `/localnowplaying` - Show current track\n• `/localplaylist [page]` - Show playlist\n• `/localstats` - Player statistics',
              inline: false
            },
            {
              name: '📝 Custom Playlist Commands',
              value: '• `/localcustomplay playlist:NAME` - Play your custom playlist\n• `/localcustomlist` - View all custom playlists\n• `/localaddtoplaylist` - Add tracks to custom playlist\n• `/localplaylist-play playlist:My Custom Playlists` - Browse custom playlists',
              inline: false
            },
            {
              name: '🎵 Voice Commands',
              value: '• `/join` - Join your voice channel\n• `/leave` - Leave voice channel\n• `/tts <message> [voice]` - Text-to-speech',
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
              value: '• `/restart [reason]` - Restart the bot (Admin only)\n• `/iconmanager` - Manage custom icons with auto-update\n• `/antinuke` - Anti-nuke protection settings',
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

        // Load playlist
        const playlist = player.loadPlaylist(search);
        
        if (playlist.length === 0) {
          await interaction.editReply({
            content: '❌ No music files found! Add .mp3, .wav, .ogg, .m4a, or .flac files to your music folders.',
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
            console.log('Voice connection ready for local music!');
          });

          connection.on(VoiceConnectionStatus.Disconnected, () => {
            console.log('Voice connection disconnected');
            voiceConnections.delete(interaction.guild.id);
          });
        }

        // Play specific track or first track
        const result = player.play(trackNumber ? trackNumber - 1 : 0);
        
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
          audioResource.volume.setVolume(player.volume / 100);

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
            
            // Set playing to false when track ends
            player.isPlaying = false;
            
            if (player.loop && player.getCurrentTrack()) {
              // Loop current track
              try {
                console.log('🔁 Looping current track:', player.getCurrentTrack().name);
                const loopResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name }
                });
                if (loopResource.volume) {
                  loopResource.volume.setVolume(player.volume / 100);
                }
                audioPlayer.play(loopResource);
                // isPlaying will be set to true again in the Playing event
                
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
            } else if (player.playlist.length > 1) {
              // Auto-play next track if available
              const nextResult = player.next();
              if (nextResult.success) {
                try {
                  console.log('⏭️ Auto-playing next track:', player.getCurrentTrack().name);
                  const nextResource = createAudioResource(player.getCurrentTrack().path, {
                    metadata: { title: player.getCurrentTrack().name }
                  });
                  if (nextResource.volume) {
                    nextResource.volume.setVolume(player.volume / 100);
                  }
                  audioPlayer.play(nextResource);
                  // isPlaying will be set to true again in the Playing event
                  
                  // Send auto-next notification with widget
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
                  // Try to continue with next track if current fails
                  const fallbackResult = player.next();
                  if (fallbackResult.success) {
                    try {
                      const fallbackResource = createAudioResource(player.getCurrentTrack().path);
                      if (fallbackResource.volume) {
                        fallbackResource.volume.setVolume(player.volume / 100);
                      }
                      audioPlayer.play(fallbackResource);
                    } catch (fallbackError) {
                      console.error('Fallback track also failed:', fallbackError);
                      player.isPlaying = false;
                    }
                  }
                }
              } else {
                // End of playlist, stop playing
                console.log('📻 End of playlist reached');
                player.isPlaying = false;
                
                // Send end of playlist notification
                try {
                  const endEmbed = new EmbedBuilder()
                    .setColor(0x636363)
                    .setTitle('📻 Playlist Ended')
                    .setDescription('All tracks have been played. Use `/localplay` to start again or `/localloop` to enable continuous playback.')
                    .setTimestamp();
                  await interaction.followUp({ embeds: [endEmbed] });
                } catch (error) {
                  console.error('Error sending end notification:', error);
                }
              }
            } else {
              // Single track and no loop, stop playing
              console.log('📻 Single track finished, no loop enabled');
              player.isPlaying = false;
              
              // Send single track end notification
              try {
                const singleEndEmbed = new EmbedBuilder()
                  .setColor(0x636363)
                  .setTitle('📻 Track Finished')
                  .setDescription('Track playback completed. Use `/localloop` to enable repeat or `/localplay` to play again.')
                  .setTimestamp();
                await interaction.followUp({ embeds: [singleEndEmbed] });
              } catch (error) {
                console.error('Error sending single track end notification:', error);
              }
            }
          });

          audioPlayer.on(AudioPlayerStatus.Paused, () => {
            console.log('🎵 Local music paused');
            player.isPaused = true;
            // Keep isPlaying true when paused (music is loaded but paused)
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

    // Playlist selection command
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

        // Handle custom playlist selection
        if (playlistType === 'custom') {
          if (!customPlaylistName) {
            // Show available custom playlists
            const customPlaylists = player.getCustomPlaylistsList();
            if (customPlaylists.length === 0) {
              await interaction.editReply({
                content: '❌ You have no custom playlists! Use `/localaddtoplaylist` to create some first.',
                ephemeral: true
              });
              return;
            }

            const playlistList = customPlaylists.slice(0, 10).map((pl, index) => 
              `${index + 1}. **${pl.name}** (${pl.trackCount} tracks)`
            ).join('\n');

            const embed = new EmbedBuilder()
              .setColor(0x1DB954)
              .setTitle('📝 Your Custom Playlists')
              .setDescription(`${playlistList}\n\n**How to play:**\nUse \`/localplaylist-play playlist:My Custom Playlists custom_playlist:PLAYLIST_NAME\`\n\n**Available Commands:**\n• \`/localaddtoplaylist\` - Add tracks to playlists\n• \`/localstats\` - View all playlists`)
              .addFields(
                { name: '📊 Total Custom Playlists', value: customPlaylists.length.toString(), inline: true },
                { name: '🎵 Total Custom Tracks', value: customPlaylists.reduce((sum, pl) => sum + pl.trackCount, 0).toString(), inline: true }
              )
              .setFooter({ text: 'Custom Playlist Manager' })
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            return;
          }

          // Load specific custom playlist
          playlist = player.loadCustomPlaylistByName(customPlaylistName);
          playlistDisplayName = `📝 Custom: ${customPlaylistName}`;
          
          if (playlist.length === 0) {
            await interaction.editReply({
              content: `❌ Custom playlist "${customPlaylistName}" not found or is empty! Use \`/localaddtoplaylist playlist:${customPlaylistName}\` to add tracks.`,
              ephemeral: true
            });
            return;
          }
        } else {
          // Load predefined playlist
          playlist = player.loadPlaylist(null, playlistType);
        }
        
        if (playlist.length === 0) {
          const playlistNames = {
            'all': 'Complete Library',
            'tamil': 'Tamil Songs',
            'english': 'English Songs', 
            'rock': 'Rock & Pop',
            'movies': 'Movie Soundtracks',
            'favorites_ak': 'Favorites (A-K)',
            'favorites_lz': 'Favorites (L-Z)',
            'shuffle': 'Shuffle All'
          };
          const displayName = playlistType === 'custom' ? playlistDisplayName : playlistNames[playlistType];
          await interaction.editReply({
            content: `❌ No tracks found in "${displayName}" playlist! Try a different playlist or add more music files.`,
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
            console.log('Voice connection ready for playlist playback!');
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
          audioResource.volume.setVolume(player.volume / 100);

          // Handle player events for continuous playback
          audioPlayer.on(AudioPlayerStatus.Playing, async () => {
            console.log(`🎵 Now playing from playlist: ${player.getCurrentTrack().name}`);
            player.isPlaying = true;
            player.isPaused = false;
          });

          audioPlayer.on(AudioPlayerStatus.Idle, async () => {
            console.log('🎵 Track finished, checking for next track...');
            player.isPlaying = false;
            
            if (player.loop && player.getCurrentTrack()) {
              // Loop current track
              try {
                const loopResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name }
                });
                if (loopResource.volume) {
                  loopResource.volume.setVolume(player.volume / 100);
                }
                audioPlayer.play(loopResource);
              } catch (error) {
                console.error('Error looping track:', error);
              }
            } else {
              // Try to play next track
              const nextResult = player.next();
              if (nextResult.success) {
                try {
                  const nextResource = createAudioResource(player.getCurrentTrack().path, {
                    metadata: { title: player.getCurrentTrack().name }
                  });
                  if (nextResource.volume) {
                    nextResource.volume.setVolume(player.volume / 100);
                  }
                  audioPlayer.play(nextResource);
                } catch (error) {
                  console.error('Error playing next track:', error);
                }
              } else {
                // End of playlist - restart if continuous mode or stop
                if (enableLoop || player.loop) {
                  console.log('🔁 Restarting playlist from beginning...');
                  player.currentIndex = 0;
                  try {
                    const restartResource = createAudioResource(player.playlist[0].path, {
                      metadata: { title: player.playlist[0].name }
                    });
                    if (restartResource.volume) {
                      restartResource.volume.setVolume(player.volume / 100);
                    }
                    audioPlayer.play(restartResource);
                    player.currentTrack = player.playlist[0];
                  } catch (error) {
                    console.error('Error restarting playlist:', error);
                  }
                } else {
                  console.log('📻 Playlist ended');
                  player.isPlaying = false;
                }
              }
            }
          });

          audioPlayer.on('error', (error) => {
            console.error('Playlist audio player error:', error);
            player.isPlaying = false;
          });

          // Store the audio player
          player.setAudioPlayer(audioPlayer);

          // Send playlist selection confirmation
          const playlistNames = {
            'all': '🎵 Complete Music Library',
            'tamil': '🎭 Tamil Songs Collection',
            'english': '🎤 English Songs Collection', 
            'rock': '🎸 Rock & Pop Playlist',
            'movies': '🎬 Movie Soundtracks',
            'favorites_ak': '⭐ Favorites Collection (A-K)',
            'favorites_lz': '⭐ Favorites Collection (L-Z)',
            'shuffle': '🔀 Shuffled Complete Library'
          };

          const finalPlaylistName = playlistType === 'custom' ? playlistDisplayName : playlistNames[playlistType];

          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 Playlist Selected & Playing')
            .setDescription(`**${finalPlaylistName}**\n\n**Now Playing:** ${player.getCurrentTrack().name}`)
            .addFields(
              { name: '📊 Playlist Size', value: `${playlist.length} tracks`, inline: true },
              { name: '🔊 Volume', value: `${player.volume}%`, inline: true },
              { name: '🎤 Voice Channel', value: voiceChannel.name, inline: true },
              { name: '🔁 Loop Mode', value: player.loop ? '✅ Enabled (Continuous)' : '❌ Disabled', inline: true },
              { name: '🔀 Shuffle Mode', value: player.shuffle ? '✅ Enabled' : '❌ Disabled', inline: true },
              { name: '📍 Current Position', value: `Track 1 of ${playlist.length}`, inline: true },
              { name: '🎮 Controls Available', value: 'Use `/localpause`, `/localnext`, `/localprevious`, `/localvolume` commands', inline: false },
              { name: '📝 View Playlist', value: 'Use `/localplaylist` to see all tracks in current playlist', inline: false }
            )
            .setFooter({ text: `Playlist: ${finalPlaylistName} • Continuous playback ${player.loop ? 'enabled' : 'disabled'}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });

        } else {
          await interaction.editReply({ content: `❌ ${result.message}`, ephemeral: true });
        }
      } catch (error) {
        console.error('Playlist selection error:', error);
        await interaction.editReply({ content: '❌ Failed to start playlist. Please check your music files and try again.', ephemeral: true });
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
    if (commandName === 'localaddtoplaylist') {
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

    // Local custom playlist play command
    if (commandName === 'localcustomplay') {
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

        // Load specific custom playlist
        const playlist = player.loadCustomPlaylistByName(playlistName);
        
        if (playlist.length === 0) {
          const availablePlaylists = player.getCustomPlaylistsList();
          const playlistList = availablePlaylists.length > 0 
            ? availablePlaylists.map(pl => `• **${pl.name}** (${pl.trackCount} tracks)`).join('\n')
            : 'No custom playlists found.';

          await interaction.editReply({
            content: `❌ Custom playlist "${playlistName}" not found or is empty!\n\n**Available Custom Playlists:**\n${playlistList}\n\nUse \`/localaddtoplaylist playlist:${playlistName}\` to create it or add tracks.`,
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

          // Handle player events for continuous playback
          audioPlayer.on(AudioPlayerStatus.Playing, async () => {
            console.log(`🎵 Now playing from custom playlist "${playlistName}": ${player.getCurrentTrack().name}`);
            player.isPlaying = true;
            player.isPaused = false;
          });

          audioPlayer.on(AudioPlayerStatus.Idle, async () => {
            console.log('🎵 Custom playlist track finished, checking for next track...');
            player.isPlaying = false;
            
            if (player.loop && player.getCurrentTrack()) {
              // Loop current track
              try {
                const loopResource = createAudioResource(player.getCurrentTrack().path, {
                  metadata: { title: player.getCurrentTrack().name }
                });
                if (loopResource.volume) {
                  loopResource.volume.setVolume(player.volume / 100);
                }
                audioPlayer.play(loopResource);
              } catch (error) {
                console.error('Error looping track:', error);
              }
            } else {
              // Try to play next track
              const nextResult = player.next();
              if (nextResult.success) {
                try {
                  const nextResource = createAudioResource(player.getCurrentTrack().path, {
                    metadata: { title: player.getCurrentTrack().name }
                  });
                  if (nextResource.volume) {
                    nextResource.volume.setVolume(player.volume / 100);
                  }
                  audioPlayer.play(nextResource);
                } catch (error) {
                  console.error('Error playing next track:', error);
                }
              } else {
                // End of playlist - restart if continuous mode or stop
                if (enableLoop || player.loop) {
                  console.log('🔁 Restarting custom playlist from beginning...');
                  player.currentIndex = 0;
                  try {
                    const restartResource = createAudioResource(player.playlist[0].path, {
                      metadata: { title: player.playlist[0].name }
                    });
                    if (restartResource.volume) {
                      restartResource.volume.setVolume(player.volume / 100);
                    }
                    audioPlayer.play(restartResource);
                    player.currentTrack = player.playlist[0];
                  } catch (error) {
                    console.error('Error restarting custom playlist:', error);
                  }
                } else {
                  console.log('📻 Custom playlist ended');
                  player.isPlaying = false;
                }
              }
            }
          });

          audioPlayer.on('error', (error) => {
            console.error('Custom playlist audio player error:', error);
            player.isPlaying = false;
          });

          // Store the audio player
          player.setAudioPlayer(audioPlayer);

          // Send custom playlist confirmation
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 Custom Playlist Playing')
            .setDescription(`**📝 ${playlistName}**\n\n**Now Playing:** ${player.getCurrentTrack().name}`)
            .addFields(
              { name: '📊 Playlist Size', value: `${playlist.length} tracks`, inline: true },
              { name: '🔊 Volume', value: `${player.volume}%`, inline: true },
              { name: '🎤 Voice Channel', value: voiceChannel.name, inline: true },
              { name: '🔁 Loop Mode', value: player.loop ? '✅ Enabled (Continuous)' : '❌ Disabled', inline: true },
              { name: '🔀 Shuffle Mode', value: player.shuffle ? '✅ Enabled' : '❌ Disabled', inline: true },
              { name: '📍 Current Position', value: `Track 1 of ${playlist.length}`, inline: true },
              { name: '🎮 Controls Available', value: 'Use `/localpause`, `/localnext`, `/localprevious`, `/localvolume` commands', inline: false },
              { name: '📝 Playlist Management', value: 'Use `/localaddtoplaylist` to add more tracks to this playlist', inline: false }
            )
            .setFooter({ text: `Custom Playlist: ${playlistName} • Continuous playback ${player.loop ? 'enabled' : 'disabled'}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });

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
    if (commandName === 'localcustomlist') {
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
    if (commandName === 'localcustomnowplaying') {
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
            .setTitle('✅ Icon Uploaded Successfully')
            .setDescription(`Custom ${iconType} icon has been uploaded and applied!`)
            .addFields(
              { name: '🎨 Icon Type', value: iconType, inline: true },
              { name: '📁 Category', value: category, inline: true },
              { name: '📄 Filename', value: result.fileName, inline: true },
              { name: '💾 File Size', value: `${(iconFile.size / 1024).toFixed(2)} KB`, inline: true },
              { name: '🔧 Format', value: iconFile.contentType.split('/')[1].toUpperCase(), inline: true },
              { name: '📍 Status', value: '🟢 Active and Ready', inline: true }
            )
            .setThumbnail(iconFile.url)
            .setFooter({ text: 'Custom Icon Manager • Icon successfully applied to music player' })
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

    // Handle bot mentions with re-tagging
    if (message.mentions.has(client.user)) {
      try {
        const content = message.content.replace(/<@!?\d+>/g, '').trim();
        
        if (content.length > 0) {
          const response = await getAIResponse(content, true);
          
          if (response && response.length > 10) {
            let reply = response;
            if (reply.length > 1900) {
              reply = reply.substring(0, 1900) + "...";
            }
            await message.reply(`${message.author} ${reply}`);
          } else {
            await message.reply(`${message.author} I'm here to help! What would you like to know? 🤖⚡`);
          }
        } else {
          await message.reply(`${message.author} Hello! How can I assist you today? 🤖⚡`);
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
        const cleanContent = message.content.trim();
        await message.channel.sendTyping();

        const response = await getAIResponse(cleanContent, true);

        if (response && response.length > 5) {
          let reply = response;

          if (reply.length > 1900) {
            reply = reply.substring(0, 1900) + "...";
          }

          await safeReply(message, `${message.author} ${reply}`);
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
            await safeReply(message, `${message.author} ${contextualResponse}`);
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
          await safeReply(message, `${message.author} ${errorResponse}`);
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

startBot();