# tmux session for Papercrate dev stack
new-session -d -s papercrate -n docker -c . 'docker compose up'

new-window -t papercrate:1 -n frontend -c ./frontend 'npm run dev'

new-window -t papercrate:2 -n backend -c ./backend 'cargo run --bin backend'

new-window -t papercrate:3 -n worker -c ./backend 'cargo run --bin worker'

select-window -t papercrate:0
attach-session -t papercrate
