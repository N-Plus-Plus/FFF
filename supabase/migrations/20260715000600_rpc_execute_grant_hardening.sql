revoke execute on function public.resolve_current_user(text) from public, authenticated;
revoke execute on function public.list_catalogue(text) from public, authenticated;
revoke execute on function public.nominate_imdb_show(text, text, text, integer, text, text, text, jsonb) from public, authenticated;
revoke execute on function public.withdraw_nomination(text, uuid) from public, authenticated;
revoke execute on function public.admin_remove_show(text, uuid) from public, authenticated;
revoke execute on function public.get_user_order(text) from public, authenticated;
revoke execute on function public.replace_user_ranking(text, uuid[]) from public, authenticated;
revoke execute on function public.get_board(text) from public, authenticated;
revoke execute on function public.get_board_revision(text) from public, authenticated;

grant execute on function public.resolve_current_user(text) to anon;
grant execute on function public.list_catalogue(text) to anon;
grant execute on function public.nominate_imdb_show(text, text, text, integer, text, text, text, jsonb) to anon;
grant execute on function public.withdraw_nomination(text, uuid) to anon;
grant execute on function public.admin_remove_show(text, uuid) to anon;
grant execute on function public.get_user_order(text) to anon;
grant execute on function public.replace_user_ranking(text, uuid[]) to anon;
grant execute on function public.get_board(text) to anon;
grant execute on function public.get_board_revision(text) to anon;
