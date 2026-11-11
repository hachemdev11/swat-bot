const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const ytDlp = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');
const config = require('./config.json');

const TOKEN = process.env.TOKEN || config.token;
const CLIENT_ID = process.env.CLIENT_ID || config.clientId;

if (!process.env.FFMPEG_PATH && ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

if (!TOKEN || !CLIENT_ID) {
  throw new Error('إعدادات التشغيل ناقصة: تحقق من token و clientId في config.json أو متغيرات البيئة TOKEN و CLIENT_ID.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ]
});

// خريطة لإدارة قوائم التشغيل لكل سيرفر
const queues = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('تشغيل أغنية برابط يوتيوب أو بحث')
    .addStringOption(option => 
      option.setName('query')
        .setDescription('رابط يوتيوب أو اسم الأغنية')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('تخطي الأغنية الحالية'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('إيقاف البوت وإخراجه من القناة')
].map(cmd => cmd.toJSON());

client.once('clientReady', async () => {
  console.log(`✅ تم تسجيل الدخول بنجاح باسم: ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(String(CLIENT_ID)), { body: commands });
    console.log('✨ تم تسجيل الأوامر بنجاح!');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }
});

client.on('error', error => {
  console.error('❌ خطأ في عميل Discord:', error);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, member, guildId, channel } = interaction;
  const voiceChannel = member.voice.channel;
  let serverQueue = queues.get(guildId);
  const privateReply = !voiceChannel ||
    (commandName === 'skip' && (!serverQueue || serverQueue.songs.length === 0)) ||
    (commandName === 'stop' && !serverQueue);

  try {
    await interaction.deferReply(privateReply ? { flags: 64 } : {});
  } catch (error) {
    console.error('❌ تعذر تأكيد استلام أمر Discord:', error);
    return;
  }

  if (!voiceChannel && ['play', 'skip', 'stop'].includes(commandName)) {
    return interaction.editReply('❌ يجب أن تكون متواصلاً في قناة صوتية أولاً!');
  }

  try {
    if (commandName === 'play') {
      const query = interaction.options.getString('query');

      try {
        const videoInfo = await getVideoInfo(query);

        if (!serverQueue) {
          serverQueue = {
            textChannel: channel,
            voiceChannel: voiceChannel,
            connection: null,
            player: createAudioPlayer(),
            songs: [],
            streamProcess: null,
            failedSong: null
          };

          queues.set(guildId, serverQueue);
          serverQueue.songs.push(videoInfo);

          try {
            const connection = joinVoiceChannel({
              channelId: voiceChannel.id,
              guildId: guildId,
              adapterCreator: voiceChannel.guild.voiceAdapterCreator,
              selfDeaf: false
            });

            serverQueue.connection = connection;
            connection.subscribe(serverQueue.player);

            serverQueue.player.on(AudioPlayerStatus.Idle, () => {
              const streamProcess = serverQueue.streamProcess;
              serverQueue.streamProcess = null;
              if (streamProcess && streamProcess.exitCode === null) streamProcess.kill();

              serverQueue.songs.shift();
              if (serverQueue.songs.length > 0) {
                playSong(guildId, serverQueue.songs[0]);
              } else {
                setTimeout(() => {
                  if (queues.get(guildId) !== serverQueue || serverQueue.songs.length > 0) return;
                  if (serverQueue.connection) serverQueue.connection.destroy();
                  queues.delete(guildId);
                }, 5000);
              }
            });

            serverQueue.player.on('error', error => {
              const currentSong = serverQueue.songs[0];
              if (currentSong) reportPlaybackError(serverQueue, currentSong, error);
            });

            playSong(guildId, serverQueue.songs[0]);

            const embed = new EmbedBuilder()
              .setColor('#0099ff')
              .setTitle('🎵 بدء التشغيل')
              .setDescription(`[${videoInfo.title}](${videoInfo.url})`)
              .addFields({ name: 'المدة', value: videoInfo.duration || 'غير معروف', inline: true });

            return interaction.editReply({ embeds: [embed] });

          } catch (err) {
            console.error(err);
            queues.delete(guildId);
            return interaction.editReply('❌ فشل الاتصال بالقناة الصوتية.');
          }

        } else {
          const startImmediately = serverQueue.songs.length === 0 &&
            serverQueue.player.state.status === AudioPlayerStatus.Idle;
          serverQueue.songs.push(videoInfo);
          if (startImmediately) playSong(guildId, videoInfo);
          const embed = new EmbedBuilder()
            .setColor('#00ffaa')
            .setTitle(startImmediately ? '🎵 بدء التشغيل' : '➕ تمت الإضافة إلى قائمة الانتظار')
            .setDescription(`[${videoInfo.title}](${videoInfo.url})`);
          return interaction.editReply({ embeds: [embed] });
        }

      } catch (error) {
        console.error('❌ خطأ أثناء البحث عن الأغنية:', error);
        return interaction.editReply('❌ تعذر العثور على الأغنية أو جلب معلوماتها. جرّب رابطًا آخر أو أعد المحاولة لاحقًا.');
      }
    }

    else if (commandName === 'skip') {
      if (!serverQueue || serverQueue.songs.length === 0) {
        return interaction.editReply('❌ لا توجد أغاني لتخطيها!');
      }
      serverQueue.player.stop();
      return interaction.editReply('⏭️ تم تخطي الأغنية.');
    }

    else if (commandName === 'stop') {
      if (!serverQueue) {
        return interaction.editReply('❌ البوت ليس في قناة صوتية!');
      }
      serverQueue.songs = [];
      if (serverQueue.streamProcess && serverQueue.streamProcess.exitCode === null) {
        serverQueue.streamProcess.kill();
        serverQueue.streamProcess = null;
      }
      serverQueue.player.stop();
      if (serverQueue.connection) serverQueue.connection.destroy();
      queues.delete(guildId);
      return interaction.editReply('⏹️ تم إيقاف التشغيل ومغادرة القناة.');
    }
  } catch (error) {
    console.error('❌ خطأ أثناء معالجة أمر Discord:', error);
    const message = '❌ حدث خطأ أثناء تنفيذ الأمر. راجع سجل البوت للتفاصيل.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(replyError => {
        console.error('❌ تعذر إرسال رد الخطأ إلى Discord:', replyError);
      });
    } else {
      await interaction.reply({ content: message, flags: 64 }).catch(replyError => {
        console.error('❌ تعذر إرسال رد الخطأ إلى Discord:', replyError);
      });
    }
  }
});

async function getVideoInfo(query) {
  const search = query.trim();
  let isUrl = false;
  try {
    const url = new URL(search);
    isUrl = ['youtube.com', 'youtu.be'].some(host =>
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    );
  } catch {
    isUrl = false;
  }
  const input = isUrl ? search : `ytsearch1:${search}`;
  const result = await ytDlp(input, {
    dumpSingleJson: true,
    noWarnings: true,
    skipDownload: true,
    playlistEnd: 1,
    jsRuntimes: 'node'
  });
  const video = result.entries ? result.entries[0] : result;
  if (!video || !video.id || !(video.webpage_url || video.url)) {
    throw new Error('لم يتم العثور على فيديو صالح في نتيجة YouTube.');
  }

  return {
    title: video.title || 'بدون عنوان',
    url: video.webpage_url || video.url,
    duration: video.duration_string || 'غير معروف'
  };
}

async function playSong(guildId, song) {
  const serverQueue = queues.get(guildId);
  if (!serverQueue || !song) return;

  try {
    serverQueue.failedSong = null;
    const streamProcess = ytDlp.exec(song.url, {
      format: 'bestaudio[acodec=opus][ext=webm]',
      output: '-',
      noWarnings: true,
      noPlaylist: true,
      quiet: true,
      jsRuntimes: 'node'
    }, { buffer: false });

    serverQueue.streamProcess = streamProcess;
    if (streamProcess.stderr) streamProcess.stderr.resume();
    streamProcess.catch(error => {
      if (serverQueue.streamProcess !== streamProcess) return;
      reportPlaybackError(serverQueue, song, error.stderr || error);
      serverQueue.streamProcess = null;
      if (queues.get(guildId) === serverQueue) serverQueue.player.stop();
    });

    const resource = createAudioResource(streamProcess.stdout, {
      inputType: StreamType.WebmOpus,
      inlineVolume: true
    });
    resource.volume.setVolume(1.0);
    serverQueue.player.play(resource);
  } catch (error) {
    reportPlaybackError(serverQueue, song, error.stderr || error);
    if (serverQueue.streamProcess && serverQueue.streamProcess.exitCode === null) {
      serverQueue.streamProcess.kill();
    }
    serverQueue.streamProcess = null;
    serverQueue.songs.shift();
    if (serverQueue.songs.length > 0) {
      playSong(guildId, serverQueue.songs[0]);
    }
  }
}

function reportPlaybackError(serverQueue, song, error) {
  if (serverQueue.failedSong === song) return;
  serverQueue.failedSong = song;
  console.error('خطأ في تشغيل الصوت:', error);
  serverQueue.textChannel.send(`❌ حدث خطأ في تشغيل: **${song.title}**، جاري التخطي...`).catch(replyError => {
    console.error('تعذر إرسال إشعار خطأ التشغيل:', replyError);
  });
}

client.login(TOKEN).catch(error => {
  console.error('❌ تعذر تسجيل الدخول إلى Discord:', error);
  process.exitCode = 1;
});